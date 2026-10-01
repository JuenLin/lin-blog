-- DropForeignKey
ALTER TABLE `comments` DROP FOREIGN KEY `comments_article_id_fkey`;

-- DropIndex
DROP INDEX `comments_article_id_deleted_at_created_at_idx` ON `comments`;

-- CreateIndex
CREATE INDEX `comments_article_id_created_at_idx` ON `comments`(`article_id`, `created_at`);

-- AddForeignKey
ALTER TABLE `comments` ADD CONSTRAINT `comments_article_id_fkey` FOREIGN KEY (`article_id`) REFERENCES `articles`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
