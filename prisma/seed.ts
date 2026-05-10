import "dotenv/config"
import Database from "better-sqlite3"
import { randomBytes } from "node:crypto"

const dbPath = process.env.AGENT_DB_PATH ?? "./dev.db"
const db = new Database(dbPath, { fileMustExist: true })

const EXPENSE = [
  "Housing",
  "Groceries",
  "Transport",
  "Dining & Bars",
  "Entertainment",
  "Health",
  "Subscriptions",
  "Shopping",
]
const INCOME = ["Salary", "Freelance", "Investments"]

function cuid() {
  return "c" + Date.now().toString(36) + randomBytes(8).toString("hex")
}

const upsertCategory = db.prepare(
  `INSERT OR IGNORE INTO Category (id, name, kind) VALUES (?, ?, ?)`,
)
const upsertCard = db.prepare(
  `INSERT OR IGNORE INTO Card (keyword, label, kind) VALUES (?, ?, ?)`,
)

const DEFAULT_CARDS: { keyword: string; label: string; kind: "DEBIT" | "CREDIT" }[] = [
  { keyword: "debit", label: "Handelsbanken", kind: "DEBIT" },
  { keyword: "amex", label: "Amex", kind: "CREDIT" },
]

let categoriesAdded = 0
let cardsAdded = 0
const tx = db.transaction(() => {
  for (const name of EXPENSE) {
    const r = upsertCategory.run(cuid(), name, "EXPENSE")
    if (r.changes > 0) categoriesAdded++
  }
  for (const name of INCOME) {
    const r = upsertCategory.run(cuid(), name, "INCOME")
    if (r.changes > 0) categoriesAdded++
  }
  for (const c of DEFAULT_CARDS) {
    const r = upsertCard.run(c.keyword, c.label, c.kind)
    if (r.changes > 0) cardsAdded++
  }
})
tx()

console.log(
  `Seeded. Added ${categoriesAdded} categor${categoriesAdded === 1 ? "y" : "ies"}, ${cardsAdded} card${cardsAdded === 1 ? "" : "s"}.`,
)
db.close()
