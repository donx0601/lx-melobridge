/**
 * @name 自有媒体测试音源
 * @description 用于验证洛雪脚本运行器，不包含第三方平台解析
 * @version 1.0.0
 * @author lx-melobridge
 */
const { EVENT_NAMES, on, send } = globalThis.lx

on(EVENT_NAMES.request, ({ action, info }) => {
  if (action !== 'musicUrl') return Promise.reject(new Error('Unsupported action'))
  const url = info.musicInfo?.authorizedUrl
  return url ? Promise.resolve(url) : Promise.reject(new Error('musicInfo.authorizedUrl is required'))
})

send(EVENT_NAMES.inited, {
  openDevTools: false,
  sources: {
    local: { name: '自有媒体', type: 'music', actions: ['musicUrl'], qualitys: [] },
  },
})
