export function getUser(id: string): unknown {
  return db.query(`SELECT * FROM users WHERE id = ${id}`);
}
