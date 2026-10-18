-- AlterTable
ALTER TABLE `notifications` MODIFY `type` ENUM('COMMENT', 'REPLY', 'FOLLOW', 'LIKE', 'MENTION', 'COMMENT_LIKE', 'REPORT_RESOLVED', 'REPORT_REJECTED') NOT NULL;

-- CreateTable
CREATE TABLE `reports` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `reporter_id` INTEGER NOT NULL,
    `target_type` ENUM('ARTICLE', 'COMMENT') NOT NULL,
    `target_id` INTEGER NOT NULL,
    `reason` VARCHAR(200) NULL,
    `status` ENUM('PENDING', 'RESOLVED', 'REJECTED') NOT NULL DEFAULT 'PENDING',
    `resolved_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `reports_target_type_target_id_idx`(`target_type`, `target_id`),
    INDEX `reports_status_idx`(`status`),
    UNIQUE INDEX `reports_reporter_id_target_type_target_id_key`(`reporter_id`, `target_type`, `target_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `reports` ADD CONSTRAINT `reports_reporter_id_fkey` FOREIGN KEY (`reporter_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
