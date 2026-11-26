# 开通刷题账号

1. 创建一个 Supabase Free 项目。在 SQL Editor 中执行 [数据库迁移](supabase/migrations/20261124000000_practice_records.sql)。迁移启用行级安全策略，每个账号只可读取和更新自己的记录。
2. 在 Authentication 中启用 Email 登录，保留邮箱验证。把 Site URL 设置为 `https://yanevening.github.io/`，并把同一地址加入 Redirect URLs。
3. 当前使用管理员创建的邮箱账号。在 Authentication → Sign In / Providers 关闭 **Allow new users to sign up**。在 Authentication → Users → Add user → Create new user 中填写邮箱和初始密码，确认用户身份后勾选 **Auto confirm user**。该操作不发送邮件。
4. 把项目 URL 和 Publishable key 填入 [cloud-config.js](cloud-config.js)。GitHub Pages 会公开这个配置文件，请使用 `sb_publishable_*` 公钥。
5. 用两个不同账号验收。在第一个账号完成一道题并保存编程草稿，再用另一浏览器登录同一账号，检查错题和草稿是否同步。切换到第二个账号，检查其记录是否独立。

账号同步涵盖客观题答案、错题状态、公开样例作答状态和编程草稿。访客原有数据保留在本机，登录后可在账号菜单里导入，已有的账号记录优先。自行导入的题库和题目隐藏设置仍保存在当前浏览器。

账号角色使用 [权限迁移](supabase/migrations/20261126000000_account_roles.sql)。普通用户同步自己的练习记录。管理员在账号中心管理其他账号的角色和启用状态。新账号默认是普通用户，停用账号的云端读写会被数据库拒绝。管理员自己的角色和状态由数据库保护，可由其他管理员调整。

迁移仅在已有账号恰好为一个时把它设为初始管理员。多个已有账号时，需要项目所有者在 SQL Editor 指定管理员。

登录界面位于 `/?page=login`，点站点右上角的「登录」即可进入。新增用户仍通过 Supabase Authentication 创建，角色调整在刷题站账号中心完成。停用会阻止账号访问云端记录，未登录和停用账号进入登录页，只有启用账号可进入刷题界面。

以后若开放自助登录，需先在 Supabase 重新允许注册。接入 GitHub OAuth 后可开启 `githubLogin`。接入自定义 SMTP 后可开启 `emailRegistration`，并确认普通访客能收到验证邮件。

[Supabase GitHub 登录](https://supabase.com/docs/guides/auth/social-login/auth-github) · [Supabase 邮件配置](https://supabase.com/docs/guides/auth/auth-smtp) · [Supabase 公钥](https://supabase.com/docs/guides/getting-started/api-keys)

所有刷题页面均要求登录。退出后返回登录页，旧版本访客记录可在登录后导入。GitHub Pages 的静态文件和公开源码仍可直接访问，题库保密需要受认证保护的服务端存储。
