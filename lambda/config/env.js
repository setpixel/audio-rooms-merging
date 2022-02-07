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
  },
  AWS_SECRET_ACCESS_KEY: 'WvQieSuw4bKWrwIvMRya9bw2BnlMt6UjQwGOqRxX',
  AWS_ACCESS_KEY: 'AKIA5UNHRQB42XSPUZOW',
  AWS_REGION: 'us-east-1',
  AWS_BUCKET_NAME: 'wonderaudiorecords'
};

module.exports = env;