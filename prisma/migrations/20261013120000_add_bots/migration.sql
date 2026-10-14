-- CreateEnum
CREATE TYPE "BotKind" AS ENUM ('main', 'sub');
CREATE TYPE "BotFaceShape" AS ENUM ('circle', 'oval', 'squircle');

-- CreateTable bots
CREATE TABLE "bots" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "BotKind" NOT NULL,
    "face_color" TEXT NOT NULL,
    "face_shape" "BotFaceShape" NOT NULL,
    "system_prompt" TEXT,
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "bots_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "bots_user_id_updated_at_idx" ON "bots"("user_id", "updated_at");
CREATE INDEX "bots_user_id_kind_idx" ON "bots"("user_id", "kind");

ALTER TABLE "bots" ADD CONSTRAINT "bots_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 1) 可空 bot_id（尚无 FK / UNIQUE）
ALTER TABLE "conversations" ADD COLUMN "bot_id" UUID;

-- 2) 数据回填：每用户保证有未删 main；未删会话挂 bot；已删会话挂已删 sub
-- 无未删会话的用户也建 main + 空会话
INSERT INTO "bots" ("id", "user_id", "name", "kind", "face_color", "face_shape", "deleted_at", "created_at", "updated_at")
SELECT gen_random_uuid(), u."id", '牛马', 'main', '#0A0A0A', 'circle', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "users" u
WHERE NOT EXISTS (
  SELECT 1 FROM "bots" b WHERE b."user_id" = u."id" AND b."kind" = 'main' AND b."deleted_at" IS NULL
);

-- 每用户第一条未删会话 → 主 Bot
WITH ranked AS (
  SELECT c."id" AS conversation_id, c."user_id",
         ROW_NUMBER() OVER (PARTITION BY c."user_id" ORDER BY c."created_at" ASC, c."id" ASC) AS rn
  FROM "conversations" c
  WHERE c."deleted_at" IS NULL AND c."bot_id" IS NULL
),
mains AS (
  SELECT b."id" AS bot_id, b."user_id"
  FROM "bots" b
  WHERE b."kind" = 'main' AND b."deleted_at" IS NULL
)
UPDATE "conversations" c
SET "bot_id" = m.bot_id
FROM ranked r
JOIN mains m ON m."user_id" = r."user_id"
WHERE c."id" = r.conversation_id AND r.rn = 1;

-- 其余未删会话 → 各建 sub（逐会话 INSERT 再 UPDATE，禁止 name=title 匹配）
DO $$
DECLARE
  r RECORD;
  new_bot_id UUID;
BEGIN
  FOR r IN
    SELECT c."id", c."user_id", c."title"
    FROM "conversations" c
    WHERE c."deleted_at" IS NULL AND c."bot_id" IS NULL
  LOOP
    new_bot_id := gen_random_uuid();
    INSERT INTO "bots" ("id", "user_id", "name", "kind", "face_color", "face_shape", "deleted_at", "created_at", "updated_at")
    VALUES (new_bot_id, r."user_id", r."title", 'sub', '#DB2777', 'circle', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
    UPDATE "conversations"
    SET "bot_id" = new_bot_id
    WHERE "id" = r."id";
  END LOOP;
END $$;

-- 已软删会话 → 已删 sub（逐会话 INSERT 再 UPDATE，禁止 name 匹配）
DO $$
DECLARE
  r RECORD;
  new_bot_id UUID;
BEGIN
  FOR r IN
    SELECT c."id", c."user_id", c."title", c."deleted_at"
    FROM "conversations" c
    WHERE c."deleted_at" IS NOT NULL AND c."bot_id" IS NULL
  LOOP
    new_bot_id := gen_random_uuid();
    INSERT INTO "bots" ("id", "user_id", "name", "kind", "face_color", "face_shape", "deleted_at", "created_at", "updated_at")
    VALUES (new_bot_id, r."user_id", r."title", 'sub', '#DB2777', 'circle', r."deleted_at", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
    UPDATE "conversations"
    SET "bot_id" = new_bot_id
    WHERE "id" = r."id";
  END LOOP;
END $$;

-- 无会话的用户：为 main 建空 Conversation
INSERT INTO "conversations" ("id", "user_id", "title", "bot_id", "created_at", "updated_at")
SELECT gen_random_uuid(), b."user_id", b."name", b."id", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "bots" b
WHERE b."kind" = 'main' AND b."deleted_at" IS NULL
  AND NOT EXISTS (SELECT 1 FROM "conversations" c WHERE c."bot_id" = b."id");

-- 3) 断言
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "conversations" WHERE "bot_id" IS NULL) THEN
    RAISE EXCEPTION 'conversations.bot_id still null after backfill';
  END IF;
END $$;

-- 4–6) NOT NULL + UNIQUE + FK + 部分唯一
ALTER TABLE "conversations" ALTER COLUMN "bot_id" SET NOT NULL;
CREATE UNIQUE INDEX "conversations_bot_id_key" ON "conversations"("bot_id");
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_bot_id_fkey"
  FOREIGN KEY ("bot_id") REFERENCES "bots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "bots_user_main_undeleted_key"
  ON "bots" ("user_id")
  WHERE "kind" = 'main' AND "deleted_at" IS NULL;
