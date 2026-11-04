# Linux 云服务器部署指南

本文说明如何在带公网地址的 Linux 云服务器上部署 lx-melobridge。文件名沿用早期的腾讯云
部署文档，但流程适用于提供标准 Ubuntu/Debian 实例的多数云服务商。

部署完成后，Subsonic/OpenSubsonic 客户端通过以下地址访问服务：

```text
https://你的域名或公网IP
```

## 1. 部署准备

### 1.1 服务器

建议配置：

- Ubuntu Server 22.04 或 24.04，64 位；
- 2 核 CPU、2 GB 内存；
- 10 GB 以上可用磁盘；
- 4 Mbps 或更高公网带宽；
- 独享公网 IPv4，或已解析到服务器的域名。

1 核 1 GB 实例也可能运行，但在线搜索和首次播放的解析速度通常较慢。

### 1.2 必需文件与客户端

- 一个可信且可用的 LX Music 格式 `.js` 音源文件；
- 一个支持 Subsonic 或 OpenSubsonic 的移动音乐客户端；
- 云服务商控制台和服务器 SSH/WebShell 的访问权限。

本项目不分发第三方音源。可参考 README 中列出的社区音源项目，自行取得脚本并判断其
可信性、使用条件和可用性。

iOS 推荐使用 App Store 中的
[箭头音乐 - 自建音乐服务客户端](https://apps.apple.com/cn/app/%E7%AE%AD%E5%A4%B4%E9%9F%B3%E4%B9%90-%E8%87%AA%E5%BB%BA%E9%9F%B3%E4%B9%90%E6%9C%8D%E5%8A%A1%E5%AE%A2%E6%88%B7%E7%AB%AF/id6758010612)。
这是项目作者目前实际使用和重点测试的客户端。

## 2. 配置云防火墙

在云控制台的“防火墙”“安全组”或“防火墙规则”中添加：

| 协议 | 端口 | 来源 | 用途 |
| --- | --- | --- | --- |
| TCP | 22 | 建议限制为管理者 IP | SSH 登录 |
| TCP | 80 | `0.0.0.0/0` | HTTPS 证书签发和 HTTP 跳转 |
| TCP | 443 | `0.0.0.0/0` | 客户端 HTTPS 访问 |
| UDP | 443 | `0.0.0.0/0`，可选 | HTTP/3 |

不要对公网放行 `3100`、`3200`、`4780` 或 `4781`。这些端口只用于容器内部通信和本机
诊断。

## 3. 登录服务器

可以使用云服务商提供的 WebShell，也可以从本机终端连接：

```bash
ssh ubuntu@服务器公网IP
```

如果实例的默认用户是 `root`，将 `ubuntu` 替换为 `root`。下文命令均在服务器终端执行。

## 4. 从 GitHub 获取项目

无需下载或上传项目压缩包。执行：

```bash
sudo apt-get update
sudo apt-get install -y git curl
sudo mkdir -p /opt/lx-melobridge
sudo chown -R "$(id -u):$(id -g)" /opt/lx-melobridge
git clone https://github.com/donx0601/lx-melobridge.git /opt/lx-melobridge
cd /opt/lx-melobridge
```

## 5. 上传音源文件

可使用云控制台的“上传文件”功能，将 `.js` 文件上传到登录用户目录，例如：

```text
/home/ubuntu/source.js
```

也可以从电脑使用 `scp`：

```bash
scp "本地音源.js" ubuntu@服务器公网IP:/home/ubuntu/source.js
```

如果音源项目提供可信的原始下载地址，可直接下载：

```bash
curl -fL '音源文件原始地址' -o "$HOME/source.js"
```

不要把音源脚本提交到 lx-melobridge 仓库，也不要运行无法确认来源的脚本。

## 6. 自动安装

执行：

```bash
cd /opt/lx-melobridge
bash scripts/install-cloud.sh
```

安装程序会依次要求输入：

1. 公网 IP 或域名，不带 `https://`、端口和路径；
2. 已上传音源文件的绝对路径；
3. 手机播放器登录用户名；
4. 音源管理页登录用户名。

密码和内部服务令牌会自动随机生成。脚本将完成 Docker 检查或安装、文件复制、目录权限、
`.env` 配置、Compose 校验和容器启动。

如果项目目录中已经存在 `.env`，脚本会停止，避免覆盖现有凭据。更新已有实例时不要重新
执行安装脚本。

安装结束后终端会显示：

- 客户端服务器地址；
- 播放器用户名和密码；
- 音源管理页地址、用户名和密码；
- 健康检查地址。

请立即将这些信息保存到密码管理器。

## 7. 验证服务

首次启动需要下载容器镜像并初始化 HTTPS，通常需要一至三分钟。

浏览器访问：

```text
https://你的域名或公网IP/healthz
```

正常响应示例：

```json
{
  "ok": true,
  "version": "0.5.6",
  "navidromeConfigured": false,
  "providers": [
    {
      "key": "lx_catalog",
      "enabled": true
    }
  ]
}
```

随后访问音源管理页：

```text
https://你的域名或公网IP/source-admin/
```

使用安装结果中的管理账号登录。页面应显示当前音源文件和运行状态。

## 8. 配置移动客户端

在移动音乐客户端中新增服务：

```text
类型：Subsonic
服务器地址：https://你的域名或公网IP
用户名：安装结果中的播放器用户名
密码：安装结果中的播放器密码
```

标准 HTTPS 使用 443 端口，地址中无需附加端口。客户端如提供“用户名/密码认证”开关，
应将其开启。

连接成功后建议依次验证：

1. 搜索歌曲并确认结果包含标题、艺术家、时长和来源；
2. 播放歌曲并拖动进度条；
3. 查看同步歌词；
4. 收藏歌曲并刷新收藏页面；
5. 连续播放两首歌曲，并在锁屏状态下验证自动切换；
6. 刷新歌单页，检查榜单和最近播放数据。

## 9. 功能页面

### 音源管理

```text
https://你的域名或公网IP/source-admin/
```

将新的 `.js` 文件复制到 `/opt/lx-melobridge/sources/` 后，可在此页面切换。切换音源不会
改变客户端连接地址。

### 在线歌单与榜单

```text
https://你的域名或公网IP/playlists
```

使用播放器账号登录。页面用于搜索和订阅在线歌单；动态榜单会通过 Subsonic 歌单接口提供
给客户端。

### 网络电台

```text
https://你的域名或公网IP/radios
```

使用播放器账号登录。应填写可直接播放的音频直播流地址，而不是普通网页地址。

## 10. 日志与故障诊断

查看全部服务日志：

```bash
cd /opt/lx-melobridge
sudo docker compose --env-file .env -f compose.cloud.yaml logs --tail=200
```

持续查看日志：

```bash
sudo docker compose --env-file .env -f compose.cloud.yaml logs -f --tail=100
```

查看指定服务：

```bash
sudo docker compose --env-file .env -f compose.cloud.yaml logs --tail=200 lx-source-runner
sudo docker compose --env-file .env -f compose.cloud.yaml logs --tail=200 lx-catalog-adapter
sudo docker compose --env-file .env -f compose.cloud.yaml logs --tail=200 lx-melobridge-gateway
sudo docker compose --env-file .env -f compose.cloud.yaml logs --tail=200 caddy
```

常见问题：

| 现象 | 检查项 |
| --- | --- |
| HTTPS 无法访问 | 公网 IP/域名、80/443 防火墙、Caddy 日志 |
| 客户端无法登录 | 地址是否使用 `https://`、认证开关、播放器账号密码 |
| 可以搜索但不能播放 | 当前音源解析能力、音源运行器日志、是否需要切换脚本 |
| 没有歌词或封面 | 音源是否返回对应字段、客户端是否缓存旧结果 |
| 容器重复重启 | Compose 日志中最早出现的异常、文件权限和 `.env` 配置 |
| 锁屏后无法切换下一首 | 客户端是否提交播放队列、网关预取日志、服务器带宽和解析耗时 |

## 11. 更新与备份

更新前备份运行数据：

```bash
cd /opt/lx-melobridge
sudo tar -czf "$HOME/lx-melobridge-backup.tar.gz" .env sources data runner-data
```

然后拉取新版本并重建容器：

```bash
git pull --ff-only
sudo docker compose --env-file .env -f compose.cloud.yaml config --quiet
sudo docker compose --env-file .env -f compose.cloud.yaml up -d --force-recreate
```

不要重新运行首次安装脚本，也不要删除 `.env`、`sources`、`data` 或 `runner-data`。备份包含
登录密码和音源脚本，应作为敏感文件保存。

## 12. 安全建议

- 为播放器账号、管理账号和 SSH 使用不同的强密码；
- 将 SSH 端口的来源地址限制为可信 IP；
- 只允许 Caddy 的 80/443 端口对公网提供服务；
- 定期更新服务器系统、Docker 镜像和 lx-melobridge；
- 只运行来源可信且经过审查的音源脚本；
- 不要公开 `.env`、音源脚本、Cookie、Token、日志或备份；
- 不要建立无认证的公共实例。
