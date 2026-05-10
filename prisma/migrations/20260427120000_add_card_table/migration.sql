-- CreateTable
CREATE TABLE "Card" (
    "keyword" TEXT NOT NULL PRIMARY KEY,
    "label" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable (MemoryFile was previously created at runtime; adopt it here)
CREATE TABLE IF NOT EXISTS "MemoryFile" (
    "userId" INTEGER NOT NULL,
    "path" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY ("userId", "path")
);
