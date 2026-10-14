# GPTibo Go 后端

Go + Gin + PostgreSQL，API 与业务 Worker 使用同一个二进制。此版本仅面向全新安装；匿名化后的迁移与原部署不兼容，不导入生产快照。

## Docker 本地启动

需要 Docker Compose，命令在本目录执行。首先生成三个独立随机秘密（Python 3）：

```sh
python3 scripts/init-secrets.py
cp .env.example .env
docker compose config --quiet
docker compose build api
docker compose up -d --wait postgres
docker compose --profile maintenance run --rm maintenance migrate
docker compose --profile maintenance run --rm maintenance grant-runtime
docker compose up -d --wait api worker
```

也可以在 PowerShell 使用 `./scripts/init-secrets.ps1` 初始化。秘密文件位于被忽略的 `.secrets/`，已有文件不会覆盖。API 仅监听宿主机 `127.0.0.1:8093`，PostgreSQL 不映射宿主机端口；运行数据库角色与迁移所有者分离。

### 初始化管理员

完成基础部署后，在**仓库根目录**执行：

```sh
npm run admin:setup
```

向导仅适用于 Go 后端，需要管理员用户名、固定收件邮箱、Resend 已验证的发件邮箱和 API 密钥。密钥在交互终端隐藏输入，不会发送邮件。登录同时需要邮件验证码与验证器 TOTP，必须配置可用的邮件服务。

向导生成独立随机 TOTP 密钥，将配置保存到 `services/storefront/.env.admin`、`.secrets/admin-totp`、`.secrets/resend-key`。用本机浏览器打开仓库根目录的 `.admin-auth/go-setup.html`，扫描二维码绑定验证器。该文件含登录秘密，不要分享；上述文件均被 Git 忽略。向导不会覆盖已有管理员文件，也不更改基础 `.env`。

然后在后端目录启用管理员与邮件配置：

```sh
cd services/storefront
docker compose --env-file .env --env-file .env.admin -f compose.yaml -f compose.auth.yaml up -d --wait api worker
```

如果本机使用独立 Compose 命令，将 `docker compose` 替换为 `docker-compose`。后续重建服务时也使用这组参数，以免恢复到默认未配置管理员的状态。返回 `/admin` 点击“已配置，重新检查”，输入用户名、邮件验证码与验证器中的 6 位验证码登录。

已有安装可手动维护 `ADMIN_USERNAME`、`ADMIN_EMAIL`、`MAIL_FROM` 和两个秘密文件，再用同样命令重建。更换 TOTP 前先做好恢复准备；不要使用测试中的固定认证向量。完整参数见 `compose.auth.yaml`。

其他接入参数见 `.env.integrations.example`。复制为 `.env.integrations` 后可叠加 `compose.integrations.yaml`；所有开关默认关闭，匿名适配器的保留域名无法用于真实交易。必须先按自己的上游协议完成开发和测试，不能直接填生产秘密试运行。可选域名配置在 `compose.domains.yaml`，仅使用自己新建的云资源。

## 原生开发

程序读取环境变量，不自动加载 dotenv。通过 `DATABASE_URL_FILE` 或 `DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD_FILE` 指向独立数据库；外部连接默认要求 TLS。先用所有者身份执行 `migrate` 和 `grant-runtime`，再用受限角色执行 `api` 和 `worker`：

```sh
go run ./cmd/storefront migrate
go run ./cmd/storefront grant-runtime
go run ./cmd/storefront api
# 另一个终端使用相同运行配置：
go run ./cmd/storefront worker
```

`grant-runtime` 还需 `APP_DB_PASSWORD_FILE`。运行身份需 `AUTH_SECRET_FILE`，默认公开来源为 `http://127.0.0.1:8093`。配置管理员与邮件后才能使用完整后台登录。根目录执行 `npx vite --config services/storefront/vite.config.ts` 启动前端。

## 测试

先在仓库根目录执行 `npm ci`；前后端路由契约测试需要 TypeScript 解析器。

```sh
go test ./...
go vet ./...
# 专用本机 PostgreSQL，库名必须以 _test 结尾：
STOREFRONT_TEST_DATABASE_URL='postgres://test_user:YOUR_LOCAL_PASSWORD@127.0.0.1:5432/storefront_test?sslmode=disable' go test -count=1 ./...
```

每个集成测试建立随机 schema 和受限角色，并在结束后清理，需要测试数据库所有者拥有创建角色权限。不可指向业务数据库；没有连接配置时，集成测试明确跳过。
