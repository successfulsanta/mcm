const fs = require("fs");
const path = require("path");

const migrationName = process.argv[2];

if (!migrationName) {
  console.error("Please provide a migration name");
  process.exit(1);
}

// Find the highest migration number
const migrationsDir = path.join(__dirname, "..", "migrations");
const existingMigrations = fs
  .readdirSync(migrationsDir)
  .filter((file) => file.endsWith(".js"));
const lastMigrationNumber =
  existingMigrations.length > 0
    ? parseInt(existingMigrations[existingMigrations.length - 1].split("_")[0])
    : -1;

// Create new migration number (zero-padded)
const newMigrationNumber = (lastMigrationNumber + 1)
  .toString()
  .padStart(4, "0");
const formattedName = migrationName.toLowerCase().replace(/\s+/g, "_");
const newMigrationFileName = `${newMigrationNumber}_${formattedName}.js`;

// Create migration file from template
const template = `const name = '${newMigrationNumber}_${formattedName}';

module.exports = {
  name,
  up: \`
-- SQL for applying migration

  \`,
  down: \`
-- SQL for rolling back migration

  \`
};
`;

fs.writeFileSync(path.join(migrationsDir, newMigrationFileName), template);
console.log(`Created migration: ${newMigrationFileName}`);
