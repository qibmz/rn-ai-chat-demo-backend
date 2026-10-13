-- CreateTable
CREATE TABLE "chat_weekly_spends" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "period" TEXT NOT NULL,
    "spend_micros" BIGINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chat_weekly_spends_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "chat_weekly_spends_period_idx" ON "chat_weekly_spends"("period");

-- CreateIndex
CREATE UNIQUE INDEX "chat_weekly_spends_user_id_period_key" ON "chat_weekly_spends"("user_id", "period");

-- AddForeignKey
ALTER TABLE "chat_weekly_spends" ADD CONSTRAINT "chat_weekly_spends_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
