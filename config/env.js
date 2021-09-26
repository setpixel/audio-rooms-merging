/**
 * Copyright by Felipe Mantilla Gomez
 */

const env = {
  database: 'wonderunit',
  username: 'postgres',
  password: 'password',
  host: 'localhost',
  // host: 'database-1.c9prvctpzevg.us-east-1.rds.amazonaws.com',
  dialect: 'postgres',
  pool: {
    max: 5,
    min: 0,
    acquire: 30000,
    idle: 10000
  }
};

module.exports = env;