# lx-melobridge

lx-melobridge 是一个面向移动音乐客户端的自托管协议桥接服务。它在 Linux 服务器上运行
兼容 LX Music 自定义音源 API 的 JavaScript 音源脚本，并向客户端提供
Subsonic/OpenSubsonic 接口。借助这一转换，iPhone 上支持 Subsonic 的播放器可以完成在线
搜索、播放、歌词、收藏、歌单和榜单等操作，无需开发、签名或安装自制 iOS 应用。

项目只提供协议适配、运行环境和部署工具，不包含第三方音源脚本、媒体文件、平台账号、
Cookie 或访问令牌。

## 主要功能

- 聚合展示多个在线目录的歌曲搜索结果；
- 展示歌名、艺术家、专辑、时长、来源及可用音质；
- 支持音频流式播放、HTTP Range 和进度拖动；
- 支持传统 LRC 与 OpenSubsonic 同步歌词；
- 支持歌曲、专辑和艺术家收藏；
- 提供专辑详情、艺术家详情、相似歌曲和随机歌曲；
- 提供在线榜单、最近播放、常听统计和播放队列；
- 支持在线歌单搜索、订阅及网络电台管理；
- 提供 Web 音源管理页，可在不修改手机客户端配置的情况下切换 `.js` 音源；
- 对播放地址进行缓存、失效重试和下一曲预取，改善移动网络及锁屏连续播放体验。

具体页面和字段由客户端决定。同一服务在不同 Subsonic 客户端中的导航入口、歌词显示和
收藏呈现方式可能不同。

## 运行条件

部署前需要准备：

| 项目 | 要求 |
| --- | --- |
| 云服务器 | 带公网 IPv4 或域名的 Linux 服务器，建议 Ubuntu Server 22.04/24.04 |
| 服务器配置 | 建议 2 核 CPU、2 GB 内存、10 GB 可用磁盘、4 Mbps 以上带宽 |
| 网络端口 | TCP 22、80、443；UDP 443 可选 |
| 音源 | 一个由用户自行取得并确认可信的 LX Music 格式 `.js` 音源文件 |
| 移动客户端 | 支持 Subsonic 或 OpenSubsonic 的音乐播放器 |
| 管理能力 | 能够登录服务器终端并执行命令，能够在云控制台配置防火墙 |

GitHub 用于保存和分发项目代码，不能代替持续运行的云服务器。纯云端部署不要求
Navidrome，也不要求自行开发 iOS 应用。

### 推荐移动客户端

推荐使用 App Store 中的
[箭头音乐 - 自建音乐服务客户端](https://apps.apple.com/cn/app/%E7%AE%AD%E5%A4%B4%E9%9F%B3%E4%B9%90-%E8%87%AA%E5%BB%BA%E9%9F%B3%E4%B9%90%E6%9C%8D%E5%8A%A1%E5%AE%A2%E6%88%B7%E7%AB%AF/id6758010612)。
该客户端原生支持 Subsonic，也是项目作者目前日常使用和重点验证的移动端。其他兼容
Subsonic/OpenSubsonic 的客户端原则上也可以连接，但功能入口和字段展示可能不同。

## 工作原理

```mermaid
flowchart LR
    Client[Subsonic / OpenSubsonic 客户端]
    Gateway[lx-melobridge Gateway]
    Catalog[在线目录适配器]
    Runner[LX 音源运行器]
    Script[用户提供的 .js 音源]

    Client -->|搜索、收藏、歌单、播放| Gateway
    Gateway --> Catalog
    Catalog --> Runner
    Runner --> Script
    Gateway -->|代理音频流、歌词与封面| Client
```

系统由三个内部服务组成：

1. **Gateway**：实现 Subsonic/OpenSubsonic 接口，维护收藏、播放记录与播放队列，并代理
   音频、歌词和封面请求。
2. **Catalog Adapter**：负责在线目录搜索、实体归一化、榜单与歌单，并在当前结果不可用时
   执行同曲匹配和来源回退。
3. **LX Source Runner**：提供 `globalThis.lx`、事件、网络请求、加密和 Buffer 等兼容环境，
   加载用户选择的 LX Music 格式音源脚本。

Caddy 作为公网入口提供 HTTPS；Docker Compose 负责启动和连接上述服务。内部服务端口不应
直接暴露到公网。

## 快速部署

完整步骤见[云服务器部署指南](TENCENT_CLOUD_DEPLOY.md)。以下命令适用于已安装 Git 的
Ubuntu/Debian 服务器；安装脚本会检查并按需安装 Docker。

### 1. 获取代码

```bash
sudo apt-get update
sudo apt-get install -y git curl
sudo mkdir -p /opt/lx-melobridge
sudo chown -R "$(id -u):$(id -g)" /opt/lx-melobridge
git clone https://github.com/donx0601/lx-melobridge.git /opt/lx-melobridge
cd /opt/lx-melobridge
```

### 2. 准备音源文件

使用云控制台的文件上传功能或 `scp`，将自己的 `.js` 音源上传至服务器，例如：

```bash
scp "本地音源.js" ubuntu@服务器公网IP:/home/ubuntu/source.js
```

也可以从音源项目提供的可信直链下载。不要运行来源不明的脚本；音源脚本会在服务器中发起
网络请求。

### 3. 执行自动安装

```bash
cd /opt/lx-melobridge
bash scripts/install-cloud.sh
```

安装程序会询问公网 IP 或域名、音源文件路径、播放器用户名和管理用户名，并自动完成：

- Docker 与 Compose 环境检查；
- 运行目录和权限配置；
- 随机密码及内部令牌生成；
- `.env` 配置创建；
- 容器启动与状态检查。

安装结束后会输出服务器地址、播放器凭据和音源管理凭据。请立即保存到密码管理器。

## 部署后配置

### 连接手机客户端

在箭头音乐或其他兼容播放器中新增 Subsonic 服务：

```text
服务类型：Subsonic
服务器地址：https://你的域名或公网IP
用户名：安装结果中的播放器用户名
密码：安装结果中的播放器密码
```

使用标准 HTTPS 端口时无需填写 `:443`。如果客户端提供“用户名/密码认证”开关，应将其
开启。

### 管理和切换音源

浏览器访问：

```text
https://你的域名或公网IP/source-admin/
```

使用安装结果中的管理账号登录。将其他 `.js` 文件放入服务器项目的 `sources` 目录后，
可在此页面选择并切换；客户端地址和登录信息保持不变。

### 歌单与榜单

浏览器访问：

```text
https://你的域名或公网IP/playlists
```

使用播放器账号登录后，可搜索和订阅在线歌单。动态榜单以及播放后生成的最近播放、常听
统计等内容，会通过客户端的歌单接口展示。

### 网络电台

浏览器访问：

```text
https://你的域名或公网IP/radios
```

使用播放器账号登录，并填写实际音频直播流地址。是否显示独立“电台”入口取决于客户端
对 Subsonic 网络电台接口的支持情况。

### 健康检查

```text
https://你的域名或公网IP/healthz
```

响应中的 `ok: true` 表示网关已启动；`version` 表示当前服务版本；`providers` 用于判断
在线目录适配器是否可用。

## 更新

通过 Git 克隆的实例可直接更新：

```bash
cd /opt/lx-melobridge
sudo tar -czf "$HOME/lx-melobridge-backup.tar.gz" .env sources data runner-data
git pull --ff-only
sudo docker compose --env-file .env -f compose.cloud.yaml config --quiet
sudo docker compose --env-file .env -f compose.cloud.yaml up -d --force-recreate
```

备份中包含密码和音源文件，不应上传到公开仓库。更新时不要删除 `.env`、`sources`、
`data` 或 `runner-data`。

## 兼容性与限制

- 第三方音源的可用性、返回字段和上游接口可能随时变化；项目无法保证所有脚本完全兼容。
- 搜索成功不代表音源一定能够解析对应歌曲；播放回退仍受候选结果和音源能力影响。
- 歌词、封面、收藏、榜单和连续播放的呈现取决于客户端实现。
- 当前不提供媒体文件永久下载、MV、评论、播客或平台级个性化推荐。
- 当前为单实例共享状态，不支持多用户隔离收藏、订阅和默认音源。

本项目不提供公共服务实例。部署者应保护服务器凭据，不应将未设置访问控制的服务开放给
公众。

## 参考项目与致谢

- [LX Music（洛雪音乐助手）](https://github.com/lyswhut/lx-music-desktop)：自定义音源 API、
  音源事件模型和同曲换源行为的主要兼容目标。
- [LX Music Source](https://github.com/lyswhut/lx-music-source)：LX Music 自定义音源的公开
  示例实现。
- [星海音乐源](https://github.com/cdyUuu/lx-music-xinghai-source)：本项目兼容测试所使用的
  社区音源项目之一。
- [pdone/lx-music-source](https://github.com/pdone/lx-music-source)：收集多种 LX Music 格式
  音源的社区项目，曾用于六音、野草等脚本的兼容性验证与部署测试。
- [Subsonic REST API](https://www.subsonic.org/pages/api.jsp) 与
  [OpenSubsonic API](https://github.com/opensubsonic/open-subsonic-api)：客户端协议兼容目标。
- [Caddy](https://github.com/caddyserver/caddy)、[Docker Compose](https://github.com/docker/compose)
  与 [Node.js](https://github.com/nodejs/node)：HTTPS、容器编排和运行环境。

lx-melobridge 是独立实现，不是上述项目的分支，也不代表相关项目或作者对本项目提供授权、
支持或背书。更完整的参考范围见[致谢与参考](ACKNOWLEDGEMENTS.md)。

## 开发与测试

本地开发需要 Node.js 22 或更高版本：

```bash
npm run check
```

当前版本为 **0.5.6**，自动化测试共 **34 项**。

## 文档

- [云服务器部署指南](TENCENT_CLOUD_DEPLOY.md)
- [更新记录](CHANGELOG.md)
- [安全说明](SECURITY.md)
- [致谢与参考](ACKNOWLEDGEMENTS.md)

## 许可证

本项目以 [Apache License 2.0](LICENSE) 发布。
