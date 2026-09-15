# 致谢与参考

lx-melobridge 是独立实现的协议桥接项目，不是下列项目的分支，也不代表下列项目对
lx-melobridge 提供授权、背书或支持。

## 主要参考

- [LX Music（洛雪音乐助手桌面版）](https://github.com/lyswhut/lx-music-desktop)：项目名称
  中 `lx` 的来源。兼容层参考其公开自定义音源 API 的行为，包括 `globalThis.lx`、事件、
  `musicUrl`、`lyric` 和同曲换源思路。本仓库不包含 LX Music 本体，也不包含任何第三方
  洛雪音源脚本。
- [LX Music Source](https://github.com/lyswhut/lx-music-source)：LX Music 自定义音源的公开
  示例实现，用于理解脚本结构及运行时接口。
- [星海音乐源](https://github.com/cdyUuu/lx-music-xinghai-source)：开发与云端部署期间用于
  兼容测试的社区音源项目之一。
- [pdone/lx-music-source](https://github.com/pdone/lx-music-source)：社区维护的 LX Music
  音源集合。本项目曾使用其中收录的六音、野草等脚本进行兼容性验证，但不复制或分发其
  音源文件。
- [Navidrome](https://github.com/navidrome/navidrome)：可选的本地音乐服务器上游。
  lx-melobridge 在 NAS 模式代理其 Subsonic 接口并合并本地与在线结果；Navidrome 不被
  打包进本项目。
- [Subsonic REST API](https://www.subsonic.org/pages/api.jsp)：客户端认证、搜索、播放、
  收藏、歌单和传统歌词接口的基础兼容目标。
- [OpenSubsonic API](https://github.com/opensubsonic/open-subsonic-api)：补充同步歌词等
  扩展能力的兼容目标。
- [Caddy](https://github.com/caddyserver/caddy)：云端 Compose 示例中的 HTTPS 入口与
  反向代理。
- [Docker Compose](https://github.com/docker/compose) 与
  [Node.js](https://github.com/nodejs/node)：项目部署编排与运行环境。

## 客户端验证

开发过程中使用音流、箭头音乐和棉花音乐验证了 Subsonic 连接、搜索、播放、Range、
收藏和歌词行为。其中
[箭头音乐](https://apps.apple.com/cn/app/%E7%AE%AD%E5%A4%B4%E9%9F%B3%E4%B9%90-%E8%87%AA%E5%BB%BA%E9%9F%B3%E4%B9%90%E6%9C%8D%E5%8A%A1%E5%AE%A2%E6%88%B7%E7%AB%AF/id6758010612)
是项目作者目前使用的主要移动客户端。这些客户端不是项目依赖；测试结果也不表示客户端
作者对本项目提供支持或背书。

音流的公开文档可见：[音流文档](https://music.aqzscn.cn/docs/)。其他客户端如没有可
确认的官方项目主页，本仓库不添加猜测性链接。

## 第三方内容

本仓库只提供音源脚本运行兼容层和示例脚本，不分发社区音源、平台账号、Cookie、密钥
或媒体文件。用户自行放入的脚本及其返回内容遵循各自的条款，与本仓库的代码许可分开。
