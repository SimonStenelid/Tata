import "dotenv/config"
import path from "node:path"
import type { PrismaConfig } from "prisma"

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required (e.g. file:./dev.db)")
}

export default {
  schema: path.join("prisma", "schema.prisma"),
  datasource: {
    url: process.env.DATABASE_URL,
  },
} satisfies PrismaConfig
