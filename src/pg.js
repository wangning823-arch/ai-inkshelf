const { Pool } = require("pg");
const fs = require("fs");
const path = require("path");

function getPgConfig() {
  const connectionString = process.env.DATABASE_URL || "";
  if (connectionString) return { connectionString };
  return {
    host: process.env.PGHOST || "127.0.0.1",
    port: Number(process.env.PGPORT || 5432),
    user: process.env.PGUSER || "postgres",
    password: process.env.PGPASSWORD || "",
    database: process.env.PGDATABASE || "aibooks",
  };
}

function createPool() {
  return new Pool(getPgConfig());
}

async function pingPg() {
  const pool = createPool();
  try {
    await pool.query("SELECT 1");
    return { ok: true };
  } finally {
    await pool.end();
  }
}

async function runSchema() {
  const schemaPath = path.join(__dirname, "..", "db", "schema.sql");
  const sql = fs.readFileSync(schemaPath, "utf-8");
  const pool = createPool();
  try {
    await pool.query(sql);
    return { ok: true };
  } finally {
    await pool.end();
  }
}

module.exports = {
  createPool,
  pingPg,
  runSchema,
};
