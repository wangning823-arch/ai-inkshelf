const { runSchema, pingPg } = require("../src/pg");

async function main() {
  const ping = await pingPg();
  if (!ping.ok) throw new Error("PostgreSQL ping failed");
  await runSchema();
  console.log("PostgreSQL schema initialized.");
}

main().catch((err) => {
  console.error("init-pg failed:", err.message);
  process.exit(1);
});
