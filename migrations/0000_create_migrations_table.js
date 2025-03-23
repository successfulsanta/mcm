const name = '0000_create_migrations_table';

module.exports = {
  name,
  up: `
CREATE TABLE IF NOT EXISTS migrations (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL UNIQUE,
  batch INT NOT NULL,
  executed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
  `,
  down: `
DROP TABLE IF EXISTS migrations;
  `
};