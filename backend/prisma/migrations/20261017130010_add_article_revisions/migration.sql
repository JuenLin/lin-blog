-- CreateTable
CREATE TABLE `article_revisions` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `article_id` INTEGER NOT NULL,
    `title` VARCHAR(100) NOT NULL,
    `content` MEDIUMTEXT NOT NULL,
    `category` VARCHAR(20) NOT NULL DEFAULT '未分类',
    `author_id` INTEGER NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `article_revisions_article_id_created_at_idx`(`article_id`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `article_revisions` ADD CONSTRAINT `article_revisions_article_id_fkey` FOREIGN KEY (`article_id`) REFERENCES `articles`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `article_revisions` ADD CONSTRAINT `article_revisions_author_id_fkey` FOREIGN KEY (`author_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
