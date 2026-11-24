# 开通刷题账号

1. 创建一个 Supabase Free 项目。在 SQL Editor 中执行 [数据库迁移](supabase/migrations/20261124000000_practice_records.sql)。迁移启用行级安全策略，每个账号只可读取和更新自己的记录。
2. 在 Authentication 中启用 Email 登录，保留邮箱验证。把 Site URL 设置为 `https://yanevening.github.io/`，并把同一地址加入 Redirect URLs。
3. 当前使用管理员创建的邮箱账号。在 Authentication → Sign In / Providers 关闭 **Allow new users to sign up**。在 Authentication → Users → Add user → Create new user 中填写邮箱和初始密码，确认用户身份后勾选 **Auto confirm user**。该操作不发送邮件。
4. 把项目 URL 和 Publishable key 填入 [cloud-config.js](cloud-config.js)。GitHub Pages 会公开这个配置文件，请使用 `sb_publishable_*` 公钥。
5. 用两个不同账号验收。在第一个账号完成一道题并保存编程草稿，再用另一浏览器登录同一账号，检查错题和草稿是否同步。切换到第二个账号，检查其记录是否独立。

账号同步涵盖客观题答案、错题状态、公开样例作答状态和编程草稿。访客原有数据保留在本机，登录后可在账号菜单里导入，已有的账号记录优先。自行导入的题库和题目隐藏设置仍保存在当前浏览器。

以后若开放自助登录，需先在 Supabase 重新允许注册。接入 GitHub OAuth 后可开启 `githubLogin`。接入自定义 SMTP 后可开启 `emailRegistration`，并确认普通访客能收到验证邮件。

[Supabase GitHub 登录](https://supabase.com/docs/guides/auth/social-login/auth-github) · [Supabase 邮件配置](https://supabase.com/docs/guides/auth/auth-smtp) · [Supabase 公钥](https://supabase.com/docs/guides/getting-started/api-keys)
