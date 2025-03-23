const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");
const dbConfig = require("../config/db.vars");
const yargs = require("yargs/yargs");
const { hideBin } = require("yargs/helpers");

const INIT_MIGRATION_NAME = "0000_create_migrations_table";
const INIT_MIGRATION_FILE = `${INIT_MIGRATION_NAME}.js`;

// Parse command line arguments
const argv = yargs(hideBin(process.argv))
  .option("up", {
    describe: "Apply migrations",
    type: "boolean",
    default: false,
  })
  .option("down", {
    describe: "Rollback migrations",
    type: "boolean",
    default: false,
  })
  .option("steps", {
    describe: "Number of migrations to rollback",
    type: "number",
    default: 1,
  })
  .option("to", {
    describe: "Migrate up to specific migration",
    type: "string",
  })
  .option("create", {
    describe: "Create a new migration file",
    type: "string",
  })
  .option("refresh", {
    describe: "Rollback all migrations and migrate up again",
    type: "boolean",
    default: false,
  })
  .help().argv;

async function getConnection() {
  return await mysql.createConnection(dbConfig);
}

async function createMigrationsTable(connection) {
  // Get the migration file
  const migrationPath = path.join(
    __dirname,
    "..",
    "migrations",
    INIT_MIGRATION_FILE
  );
  if (fs.existsSync(migrationPath)) {
    const migration = require(migrationPath);
    await connection.query(migration.up);
  }
}

async function getExecutedMigrations(connection) {
  const [rows] = await connection.query(
    "SELECT name, batch FROM migrations ORDER BY id"
  );
  return rows;
}

function getMigrationFiles() {
  const migrationsDir = path.join(__dirname, "..", "migrations");
  return fs
    .readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".js"))
    .map((file) => {
      const fullPath = path.join(migrationsDir, file);
      return {
        name: file,
        ...require(fullPath),
      };
    })
    .sort((a, b) => {
      // Sort numerically by the migration number
      const numA = parseInt(a.name.split("_")[0]);
      const numB = parseInt(b.name.split("_")[0]);
      return numA - numB;
    });
}

async function applyMigration(connection, migration, batch) {
  try {
    console.log(`Applying migration: ${migration.name}`);
    await connection.query(migration.up);
    await connection.query(
      "INSERT INTO migrations (name, batch) VALUES (?, ?)",
      [migration.name, batch]
    );
    console.log(`Migration ${migration.name} applied successfully`);
  } catch (error) {
    console.error(`Error applying migration ${migration.name}:`, error);
    throw error;
  }
}

async function rollbackMigration(connection, migration) {
  try {
    console.log(`Rolling back migration: ${migration.name}`);
    await connection.query(migration.down);
    await connection.query("DELETE FROM migrations WHERE name = ?", [
      migration.name,
    ]);
    console.log(`Migration ${migration.name} rolled back successfully`);
  } catch (error) {
    console.error(`Error rolling back migration ${migration.name}:`, error);
    throw error;
  }
}

async function migrateUp(connection, targetMigration = null) {
  // Get executed migrations
  const executedMigrations = await getExecutedMigrations(connection);
  const executedNames = executedMigrations.map((m) => m.name);

  // Get maximum batch number
  const maxBatch =
    executedMigrations.length > 0
      ? Math.max(...executedMigrations.map((m) => m.batch))
      : 0;

  // Get all migration files
  const migrationFiles = getMigrationFiles();

  // Filter to only non-executed migrations
  const pendingMigrations = migrationFiles.filter(
    (m) => !executedNames.includes(m.name)
  );

  // If target migration is specified, only run up to that migration
  let migrationsToRun = pendingMigrations;
  if (targetMigration) {
    const targetIndex = migrationFiles.findIndex(
      (m) => m.name === targetMigration
    );
    if (targetIndex === -1) {
      throw new Error(`Migration ${targetMigration} not found`);
    }

    const executedIndices = executedNames.map((name) =>
      migrationFiles.findIndex((m) => m.name === name)
    );
    const maxExecutedIndex =
      executedIndices.length > 0 ? Math.max(...executedIndices) : -1;

    if (targetIndex <= maxExecutedIndex) {
      throw new Error(
        `Cannot migrate up to ${targetMigration} as it's already been applied or an earlier migration`
      );
    }

    migrationsToRun = migrationFiles
      .filter((m, index) => index > maxExecutedIndex && index <= targetIndex)
      .filter((m) => !executedNames.includes(m.name));
  }

  // Apply migrations
  if (migrationsToRun.length === 0) {
    console.log("No pending migrations to apply");
    return;
  }

  const newBatch = maxBatch + 1;
  for (const migration of migrationsToRun) {
    await applyMigration(connection, migration, newBatch);
  }

  console.log(`Applied ${migrationsToRun.length} migration(s)`);
}

async function migrateDown(connection, steps = 1) {
  // Get executed migrations
  const executedMigrations = await getExecutedMigrations(connection);

  if (executedMigrations.length === 0) {
    console.log("No migrations to roll back");
    return;
  }

  // Group by batch (for batch rollback)
  const migrationsByBatch = {};
  executedMigrations.forEach((m) => {
    if (!migrationsByBatch[m.batch]) {
      migrationsByBatch[m.batch] = [];
    }
    migrationsByBatch[m.batch].push(m);
  });

  // Get migration files for reference
  const migrationFiles = getMigrationFiles();
  const migrationsByName = {};
  migrationFiles.forEach((m) => {
    migrationsByName[m.name] = m;
  });

  // Get batches in descending order
  const batches = Object.keys(migrationsByBatch)
    .map(Number)
    .sort((a, b) => b - a);

  // Determine how many batches to roll back
  let batchesToRollback;
  if (steps === 0) {
    return; // Nothing to do
  } else if (steps > 0) {
    batchesToRollback = batches.slice(0, steps);
  } else {
    // Negative steps means roll back all
    batchesToRollback = batches;
  }

  // Roll back migrations in reverse order within each batch
  for (const batch of batchesToRollback) {
    const migrationsInBatch = migrationsByBatch[batch].sort((a, b) => {
      // Sort by migration number in descending order
      const numA = parseInt(a.name.split("_")[0]);
      const numB = parseInt(b.name.split("_")[0]);
      return numB - numA;
    });

    for (const migration of migrationsInBatch) {
      // Skip the migrations table migration - never roll this back
      if (migration.name === INIT_MIGRATION_NAME) {
        console.log(
          `Skipping rollback of migrations table to protect system integrity`
        );
        continue;
      }

      if (migrationsByName[migration.name]) {
        await rollbackMigration(connection, migrationsByName[migration.name]);
      } else {
        console.warn(
          `Warning: Migration file for ${migration.name} not found, skipping rollback`
        );
      }
    }
  }

  console.log(`Rolled back ${batchesToRollback.length} batch(es)`);
}

async function refreshMigrations(connection) {
  // Roll back all migrations except the migrations table
  const executedMigrations = await getExecutedMigrations(connection);

  if (executedMigrations.length === 0) {
    console.log("No migrations to roll back");
  } else {
    // Group by batch (for batch rollback)
    const migrationsByBatch = {};
    executedMigrations.forEach((m) => {
      if (!migrationsByBatch[m.batch]) {
        migrationsByBatch[m.batch] = [];
      }
      // Skip adding the migrations table to the rollback list
      if (m.name !== INIT_MIGRATION_NAME) {
        migrationsByBatch[m.batch].push(m);
      }
    });

    // Get migration files for reference
    const migrationFiles = getMigrationFiles();
    const migrationsByName = {};
    migrationFiles.forEach((m) => {
      migrationsByName[m.name] = m;
    });

    // Get batches in descending order
    const batches = Object.keys(migrationsByBatch)
      .map(Number)
      .sort((a, b) => b - a);

    // Roll back all migrations except the migrations table
    for (const batch of batches) {
      const migrationsInBatch = migrationsByBatch[batch].sort((a, b) => {
        // Sort by migration number in descending order
        const numA = parseInt(a.name.split("_")[0]);
        const numB = parseInt(b.name.split("_")[0]);
        return numB - numA;
      });

      for (const migration of migrationsInBatch) {
        if (migrationsByName[migration.name]) {
          await rollbackMigration(connection, migrationsByName[migration.name]);
        } else {
          console.warn(
            `Warning: Migration file for ${migration.name} not found, skipping rollback`
          );
        }
      }
    }
  }

  // Then migrate up
  await migrateUp(connection);
}

async function main() {
  let connection;

  try {
    connection = await getConnection();
    console.log("Connected to database");

    // Create migrations table if it doesn't exist
    await createMigrationsTable(connection);

    if (argv.refresh) {
      await refreshMigrations(connection);
    } else if (argv.down) {
      await migrateDown(connection, argv.steps);
    } else if (argv.to) {
      await migrateUp(connection, argv.to);
    } else {
      // Default to migrate up
      await migrateUp(connection);
    }
  } catch (error) {
    console.error("Migration error:", error);
    process.exit(1);
  } finally {
    if (connection) await connection.end();
  }
}

main();
