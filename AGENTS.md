# 本项目 AI 协作规则

开始任何代码任务前，必须先读：

- AI_CONTRACT.md
- docs/AI_CONTRACT.md
- docs/API.md
- docs/DB.md
- docs/CODING_STYLE.md

禁止事项：

- 禁止更换 Vue / Express / Prisma / MySQL
- 禁止修改接口路径、请求/响应字段
- 禁止修改 Prisma schema
- 禁止新增 npm 依赖
- 禁止升级大版本依赖
- 禁止明文存密码、生成真实密钥/token
- 禁止手拼 SQL、SELECT *

代码风格：

- 2 空格缩进、单引号、语句加分号
- 前端 <script setup>，后端 ESM
- 统一响应 { code, message, data }
- 所有接口入参用 zod 校验

如果任务会碰到以上“禁止项”，先列问题，不要直接改。
