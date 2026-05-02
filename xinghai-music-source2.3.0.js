/*!
 * @name 星海音乐源
 * @description 主API：GDAPI（动态稳定源） | 备用API：聚合接口
 * @version v2.3.0
 * @author 万去了了 & 适配
 * @homepage https://zrcdy.dpdns.org/
 * @lastUpdate 2025-02-15
 * 
 * 音质支持说明：
 * - 主API (GDAPI)：根据稳定源动态支持，理论最高 flac24bit
 * - 备用API：服务器状态正常时可用，酷狗支持 FLAC，QQ/咪咕最高 320k（降级时使用）
 */

// ============================ 核心配置 ============================
const UPDATE_CONFIG = {
  versionApiUrl: 'https://zrcdy.dpdns.org/lx/version.php',
  latestScriptUrl: 'https://zrcdy.dpdns.org/lx/index.html',
  currentVersion: 'v2.3.0'
};

// 动态稳定源接口
const STABLE_SOURCES_API_URL = 'https://zrcdy.dpdns.org/lx/stable_sources.php';

// 主API - GD Studio
const MAIN_API_BASE = 'https://music-api.gdstudio.xyz/api.php?use_xbridge3=true&loader_name=forest&need_sec_link=1&sec_link_scene=im&theme=light';

// 备用API - 聚合接口
const BACKUP_API_BASE = 'https://zrcdy.dpdns.org/lx/api/api.php';

// ============================ 全局状态 ============================
let musicSourceEnabled = true;
let serverCheckCompleted = false;
let backupApiAvailable = false;

let stableSourcesList = null;
let mainApiSourceMap = {};
let availablePlatforms = [];

const ALL_PLATFORMS = ['wy', 'tx', 'kw', 'kg', 'mg'];

const MUSIC_QUALITY_FULL = {
  wy: ['128k', '192k', '320k', 'flac', 'flac24bit'],
  tx: ['128k', '192k', '320k', 'flac', 'flac24bit'],
  kw: ['128k', '192k', '320k', 'flac', 'flac24bit'],
  kg: ['128k', '192k', '320k', 'flac', 'flac24bit'],
  mg: ['128k', '192k', '320k', 'flac', 'flac24bit']
};

const PLATFORM_NAME_MAP = {
  wy: '网易云音乐',
  tx: 'QQ音乐',
  kw: '酷我音乐',
  kg: '酷狗音乐',
  mg: '咪咕音乐'
};

const BACKUP_SOURCE_MAP = {
  kg: 'kg',
  tx: 'qq',
  mg: 'migu'
};

const { EVENT_NAMES, request, on, send } = globalThis.lx;

// ============================ 工具函数 ============================
function log(...args) { console.log('[星海]', ...args); }
function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function logSimple(action, source, musicInfo, status, extra = '') {
  const songName = musicInfo.name || '未知歌曲';
  log(`[${action}] 平台:${source} | 歌曲:${songName} | 状态:${status}${extra ? ' | ' + extra : ''}`);
}

function buildQueryString(params) {
  const parts = [];
  for (const key in params) {
    if (params.hasOwnProperty(key)) {
      const value = params[key];
      if (value !== undefined && value !== null && value !== '') {
        parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(value));
      }
    }
  }
  return parts.join('&');
}

function mapQuality(targetQuality, availableQualities) {
  const priorityMap = {
    '臻品母带': 'flac24bit', '臻品音质2.0': 'flac24bit', '臻品音质': 'flac24bit',
    'Hires 无损24-Bit': 'flac24bit', 'FLAC': 'flac', '320k': '320k', '192k': '192k', '128k': '128k'
  };
  if (availableQualities.includes(targetQuality)) return targetQuality;
  const mapped = priorityMap[targetQuality];
  if (mapped && availableQualities.includes(mapped)) return mapped;
  const order = ['flac24bit', 'flac', '320k', '192k', '128k'];
  for (const q of order) if (availableQualities.includes(q)) return q;
  return availableQualities[0] || '128k';
}

const httpFetch = (url, options = { method: 'GET' }) => {
  return new Promise((resolve, reject) => {
    const cancelRequest = request(url, options, (err, resp) => {
      if (err) return reject(new Error(`网络请求异常：${err.message}`));
      let body = resp.body;
      if (typeof body === 'string') {
        const trimmed = body.trim();
        if (trimmed.startsWith('{') || trimmed.startsWith('[') || trimmed.startsWith('"')) {
          try { body = JSON.parse(trimmed); } catch (e) {}
        }
      }
      resolve({ body, statusCode: resp.statusCode, headers: resp.headers || {} });
    });
  });
};

/**
 * 版本比较函数，支持多段式版本号（如 2.3.0、2.2.9.5、v2.3.0 等）
 * 返回 true 表示 remoteVer > currentVer
 */
const compareVersions = (remoteVer, currentVer) => {
  const parse = (v) => {
    const cleaned = v.replace(/^v/, '');
    return cleaned.split('.').map(part => {
      const num = parseInt(part, 10);
      return isNaN(num) ? part : num;
    });
  };
  const r = parse(remoteVer);
  const c = parse(currentVer);
  const maxLen = Math.max(r.length, c.length);
  for (let i = 0; i < maxLen; i++) {
    const rv = r[i] !== undefined ? r[i] : (typeof c[i] === 'number' ? 0 : '');
    const cv = c[i] !== undefined ? c[i] : (typeof r[i] === 'number' ? 0 : '');
    if (typeof rv === 'number' && typeof cv === 'number') {
      if (rv > cv) return true;
      if (rv < cv) return false;
    } else if (typeof rv === 'string' && typeof cv === 'string') {
      if (rv > cv) return true;
      if (rv < cv) return false;
    } else {
      // 类型不同时，数字大于字符串
      if (typeof rv === 'number' && typeof cv === 'string') return true;
      if (typeof rv === 'string' && typeof cv === 'number') return false;
    }
  }
  return false;
};

/**
 * 仅去除多余空格（保留所有字符）
 */
function trimSpacesOnly(rawName) {
  if (!rawName) return '';
  return rawName.replace(/\s+/g, ' ').trim();
}

/**
 * 去除括号及括号内的内容（包括中英文括号）
 */
function removeBracketsContent(rawName) {
  if (!rawName) return '';
  let cleaned = rawName.replace(/[（(][^）)]*[）)]/g, '');
  cleaned = cleaned.replace(/\s+/g, ' ').trim();
  return cleaned;
}

/**
 * 在去除括号内容的基础上，进一步去除特殊符号（保留中英日韩文、数字、空格）
 */
function removeSpecialChars(rawName) {
  if (!rawName) return '';
  let cleaned = removeBracketsContent(rawName);
  cleaned = cleaned.replace(/[^\u4e00-\u9fa5\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af\u1100-\u11ff\u3130-\u318fa-zA-Z0-9\s]/g, '');
  cleaned = cleaned.replace(/\s+/g, ' ').trim();
  return cleaned;
}

/**
 * 严格清理：无空格、无特殊符号
 */
function cleanStrict(rawName) {
  if (!rawName) return '';
  let cleaned = removeSpecialChars(rawName);
  cleaned = cleaned.replace(/\s+/g, '');
  return cleaned.trim();
}

// ============================ 动态稳定源获取 ============================
const fetchStableSources = async () => {
  log('正在获取服务器稳定源列表...');
  try {
    const resp = await httpFetch(STABLE_SOURCES_API_URL, {
      method: 'GET', timeout: 5000,
      headers: { 'User-Agent': 'LX-Music-Mobile/星海音乐源' }
    });
    if (resp.statusCode !== 200) throw new Error(`HTTP ${resp.statusCode}`);
    let data = resp.body;
    if (typeof data === 'string') {
      try { data = JSON.parse(data); } catch (e) { throw new Error('JSON解析失败'); }
    }
    if (!Array.isArray(data) || data.length === 0) throw new Error('返回数据非数组或为空');
    stableSourcesList = data;
    log('✅ 获取稳定源成功:', stableSourcesList);
  } catch (err) {
    log('❌ 获取稳定源失败，使用默认值 [netease, kuwo]:', err.message);
    stableSourcesList = ['netease', 'kuwo'];
  }
};

const buildPlatformsFromStableSources = () => {
  const sourceToCode = {
    netease: 'wy',
    tencent: 'tx',
    kuwo: 'kw',
    kugou: 'kg',
    migu: 'mg'
  };

  mainApiSourceMap = {};
  stableSourcesList.forEach(src => {
    const code = sourceToCode[src];
    if (code) mainApiSourceMap[code] = src;
  });

  availablePlatforms = [...ALL_PLATFORMS];

  log('主API支持映射:', mainApiSourceMap);
  log('最终可用平台:', availablePlatforms);
};

// ============================ 服务器状态检查 ============================
const checkServerStatus = async () => {
  log('正在检查服务器连接状态...');
  for (let attempt = 0; attempt <= 2; attempt++) {
    if (attempt > 0) await delay(1000);
    try {
      const resp = await httpFetch('https://zrcdy.dpdns.org/lx/status.php', {
        method: 'GET', timeout: 5000,
        headers: { 'User-Agent': 'LX-Music-Mobile/星海音乐源', 'Accept': 'application/json' }
      });
      if (resp.statusCode !== 200) throw new Error(`HTTP状态码异常: ${resp.statusCode}`);
      let data = resp.body;
      if (typeof data === 'string') {
        try { data = JSON.parse(data); } catch (e) { throw new Error('JSON解析失败'); }
      }
      if (!data || typeof data !== 'object') throw new Error('无效数据格式');
      const enabled = data.enabled !== false;
      log(`服务器连接状态: ${enabled ? '服务正常' : '服务受限'}`);
      return { enabled, message: data.message || (enabled ? '服务正常' : '服务暂时不可用'), error: null };
    } catch (err) {
      log(`服务器连接检查失败(第${attempt + 1}次):`, err.message);
      if (attempt === 2) {
        log('服务器连接检查多次失败，使用本地模式');
        return { enabled: true, message: `服务器连接失败，使用本地模式: ${err.message}`, error: err.message };
      }
    }
  }
  return { enabled: true, message: '未知错误，使用本地模式', error: '未知错误' };
};

// ============================ 搜索功能 ============================
async function handleSearch(source, info) {
  if (!backupApiAvailable) {
    throw new Error('搜索功能暂不可用（服务器连接异常）');
  }
  if (!['kg', 'tx', 'mg'].includes(source)) {
    throw new Error(`平台 ${source} 暂不支持搜索`);
  }

  const backupSource = BACKUP_SOURCE_MAP[source];
  const keyword = info.key || info.keyword || '';
  if (!keyword) throw new Error('请输入搜索关键词');

  const limit = info.limit || 20;

  const params = {
    source: backupSource,
    msg: keyword,
    n: '0',
    g: String(limit)
  };
  if (backupSource === 'migu') {
    params.num = String(limit);
    delete params.g;
  }

  const url = `${BACKUP_API_BASE}?${buildQueryString(params)}`;
  log(`搜索请求: ${url}`);

  const resp = await httpFetch(url);
  if (resp.statusCode !== 200) throw new Error(`搜索接口 HTTP ${resp.statusCode}`);

  const data = resp.body;
  if (data.code !== 200) throw new Error(data.msg || '搜索失败');

  const songs = data.data?.songs || [];
  const list = songs.map((item, index) => {
    const songId = item.hash || item.mid || item.id || String(index);
    const name = item.title || item.name || '未知歌曲';
    const singer = item.singer || item.author || '未知歌手';
    const album = item.album || item.albumname || '';
    const img = item.cover || item.picture || '';
    const interval = item.duration ? Math.floor(parseInt(item.duration) * 1000) : null;

    return {
      singer,
      name,
      album,
      source,
      songmid: songId,
      interval,
      img,
      lrc: null,
      hash: songId,
      albumId: item.albumid || '',
      lyricUrl: null
    };
  });

  return {
    list,
    total: data.data?.total || list.length,
    limit,
    page: info.page || 1,
    source
  };
}

// ============================ 音频地址解析 ============================
const getMusicUrlFromMainAPI = async (source, songId, apiQuality) => {
  const apiSource = mainApiSourceMap[source];
  if (!apiSource) throw new Error('主API不支持此平台');
  const url = `${MAIN_API_BASE}&types=url&source=${apiSource}&id=${songId}&br=${apiQuality}`;
  const resp = await httpFetch(url, {
    method: 'GET',
    headers: { 'User-Agent': 'LX-Music-Mobile', 'Accept': 'application/json' }
  });
  const data = typeof resp.body === 'object' ? resp.body : JSON.parse(resp.body);
  if (!data.url) throw new Error('主API未返回音频地址');
  return data.url;
};

function stringMatchScore(str1, str2) {
  if (!str1 || !str2) return 0;
  const s1 = str1.toLowerCase().replace(/\s+/g, ' ').trim();
  const s2 = str2.toLowerCase().replace(/\s+/g, ' ').trim();
  if (s1 === s2) return 1.0;
  if (s1.includes(s2) || s2.includes(s1)) return 0.9;
  const maxLen = Math.max(s1.length, s2.length);
  let matches = 0;
  for (let i = 0; i < Math.min(s1.length, s2.length); i++) {
    if (s1[i] === s2[i]) matches++;
  }
  return matches / maxLen;
}

function findBestMatchSong(originalName, originalSinger, songs) {
  if (!songs || songs.length === 0) return null;
  
  let bestIndex = 1;
  let bestScore = -1;

  songs.forEach((song, idx) => {
    const songName = song.title || song.name || '';
    const songSinger = song.singer || song.author || '';
    
    const nameScore = stringMatchScore(originalName, songName);
    const singerScore = stringMatchScore(originalSinger, songSinger);
    const totalScore = nameScore * 0.6 + singerScore * 0.4;
    
    if (totalScore > bestScore) {
      bestScore = totalScore;
      bestIndex = idx + 1;
    }
  });

  return bestScore >= 0.3 ? bestIndex : null;
}

const getMusicUrlFromBackup = async (source, musicInfo, quality) => {
  if (!backupApiAvailable) {
    throw new Error('备用接口暂不可用（服务器连接异常）');
  }

  const backupSource = BACKUP_SOURCE_MAP[source];
  if (!backupSource) throw new Error('备用接口不支持此平台');

  const songName = musicInfo.name || '';
  const songSinger = musicInfo.singer || '';
  if (!songName) throw new Error('歌曲信息缺失，无法使用备用接口');

  // 四级关键词回退
  const keywords = [];
  const kw1 = trimSpacesOnly(songName);
  const kw2 = removeBracketsContent(songName);
  const kw3 = removeSpecialChars(songName);
  const kw4 = cleanStrict(songName);
  
  if (kw1 && !keywords.includes(kw1)) keywords.push(kw1);
  if (kw2 && !keywords.includes(kw2)) keywords.push(kw2);
  if (kw3 && !keywords.includes(kw3)) keywords.push(kw3);
  if (kw4 && !keywords.includes(kw4)) keywords.push(kw4);
  if (!keywords.includes(songName)) keywords.push(songName);

  let searchData = null;
  let usedKeyword = '';

  for (const kw of keywords) {
    const searchParams = {
      source: backupSource,
      msg: kw,
      n: '0',
      g: '10'
    };
    if (backupSource === 'migu') {
      searchParams.num = '10';
      delete searchParams.g;
    }

    const searchUrl = `${BACKUP_API_BASE}?${buildQueryString(searchParams)}`;
    log(`备用API搜索 (关键词: "${kw}"): ${searchUrl}`);

    try {
      const searchResp = await httpFetch(searchUrl);
      if (searchResp.statusCode !== 200) {
        log(`关键词 "${kw}" HTTP ${searchResp.statusCode}，尝试下一个`);
        continue;
      }
      const data = searchResp.body;
      if (data.code !== 200) {
        log(`关键词 "${kw}" 业务code ${data.code} (${data.msg || ''})，尝试下一个`);
        continue;
      }
      const songs = data.data?.songs || [];
      if (songs.length > 0) {
        searchData = data;
        usedKeyword = kw;
        break;
      } else {
        log(`关键词 "${kw}" 返回0条结果，尝试下一个`);
      }
    } catch (e) {
      log(`关键词 "${kw}" 搜索异常:`, e.message);
    }
  }

  if (!searchData) {
    throw new Error('所有关键词均未搜索到歌曲（可能接口异常或歌曲不存在）');
  }

  const songs = searchData.data?.songs || [];
  log(`使用关键词 "${usedKeyword}" 搜索到 ${songs.length} 条结果`);

  const bestN = findBestMatchSong(songName, songSinger, songs);
  if (bestN === null) throw new Error('未找到匹配的歌曲');

  log(`备用API匹配结果: n=${bestN}, 歌曲: ${songs[bestN-1]?.title || songs[bestN-1]?.name}`);

  const detailParams = {
    source: backupSource,
    msg: usedKeyword,
    n: String(bestN)
  };

  if (backupSource === 'kg') {
    const qMap = { '128k': '128', '192k': '192', '320k': '320', 'flac': 'flac', 'flac24bit': 'flac' };
    detailParams.quality = qMap[quality] || '320';
  } else if (backupSource === 'qq') {
    detailParams.size = 'hq';
  }

  const detailUrl = `${BACKUP_API_BASE}?${buildQueryString(detailParams)}`;
  log(`备用API详情请求: ${detailUrl}`);

  const detailResp = await httpFetch(detailUrl);
  if (detailResp.statusCode !== 200) throw new Error(`详情接口 HTTP ${detailResp.statusCode}`);

  const detailData = detailResp.body;
  if (detailData.code !== 200) throw new Error(detailData.msg || '获取详情失败');

  // 兼容多种播放链接字段
  const data = detailData.data;
  let musicUrl = '';
  if (backupSource === 'kg') {
    musicUrl = data?.play_url || data?.music_url || data?.url || data?.musicurl;
  } else if (backupSource === 'qq') {
    musicUrl = data?.musicurl || data?.music_url?.url || data?.url || data?.play_url;
  } else if (backupSource === 'migu') {
    musicUrl = data?.music_url || data?.url || data?.play_url;
  }

  if (!musicUrl) throw new Error('备用API返回数据中未找到音频地址');
  return musicUrl;
};

const handleGetMusicUrl = async (source, musicInfo, quality) => {
  if (!musicSourceEnabled) throw new Error('服务暂时不可用');
  if (!serverCheckCompleted) throw new Error('服务初始化中，请稍后');

  const songId = musicInfo.hash ?? musicInfo.songmid ?? musicInfo.id;
  if (!songId) throw new Error('歌曲信息不完整');

  logSimple('解析音频地址', source, musicInfo, '开始');

  const avail = MUSIC_QUALITY_FULL[source] || ['128k', '192k', '320k', 'flac'];
  const actual = mapQuality(quality, avail);
  if (actual !== quality) log(`音质自动映射: ${quality} -> ${actual}`);

  let finalUrl = null;
  let lastErr = null;

  if (mainApiSourceMap[source]) {
    try {
      const brMap = { '128k': '128', '192k': '192', '320k': '320', 'flac': '740', 'flac24bit': '999' };
      const apiBr = brMap[actual] || '320';
      finalUrl = await getMusicUrlFromMainAPI(source, songId, apiBr);
      logSimple('解析音频地址', source, musicInfo, '成功(GDAPI)');
    } catch (err) {
      lastErr = err;
      logSimple('解析音频地址', source, musicInfo, 'GDAPI失败，尝试备用API', err.message);
    }
  } else {
    log(`主API不支持平台 ${source}，直接使用备用API`);
  }

  if (!finalUrl && backupApiAvailable && BACKUP_SOURCE_MAP[source]) {
    try {
      finalUrl = await getMusicUrlFromBackup(source, musicInfo, actual);
      logSimple('解析音频地址', source, musicInfo, '成功(备用API)');
    } catch (err) {
      lastErr = err;
      logSimple('解析音频地址', source, musicInfo, '备用API失败', err.message);
    }
  }

  if (!finalUrl) {
    const msg = `无法获取音频地址：${lastErr ? lastErr.message : '未知错误'}`;
    logSimple('解析音频地址', source, musicInfo, '完全失败', msg);
    throw new Error(msg);
  }
  return finalUrl;
};

// ============================ 构建音乐源对象 ============================
const buildMusicSources = (platforms) => {
  const sources = {};
  platforms.forEach(code => {
    sources[code] = {
      name: PLATFORM_NAME_MAP[code] || code,
      type: 'music',
      actions: ['musicUrl'],
      qualitys: MUSIC_QUALITY_FULL[code]
    };
  });
  return sources;
};

// ============================ 事件监听 ============================
on(EVENT_NAMES.request, ({ action, source, info }) => {
  if (action === 'musicUrl') {
    if (!info?.musicInfo || !info.type) return Promise.reject(new Error('请求参数不完整'));
    return handleGetMusicUrl(source, info.musicInfo, info.type);
  } else if (action === 'search') {
    if (!info) return Promise.reject(new Error('搜索参数缺失'));
    return handleSearch(source, info);
  } else {
    return Promise.reject(new Error('不支持的操作类型'));
  }
});

// ============================ 初始化 ============================
(async () => {
  log('========================================');
  log('星海音乐源 v2.3.0 初始化（GDAPI动态稳定源 + 备用聚合接口）');
  log('========================================');

  try {
    const server = await checkServerStatus();
    musicSourceEnabled = server.enabled;
    backupApiAvailable = server.enabled;
    
    if (!musicSourceEnabled) {
      log('⚠️ 服务器状态异常，服务受限，禁用搜索和备用播放:', server.message);
    } else {
      log('✅ 服务器状态正常，搜索和备用播放已启用');
    }

    await fetchStableSources();
    buildPlatformsFromStableSources();
    serverCheckCompleted = true;

    const sources = buildMusicSources(availablePlatforms);
    send(EVENT_NAMES.inited, { status: true, openDevTools: false, sources, initStatus: 'ready' });

    log('✅ 初始化完成，全部平台:', availablePlatforms.join(', '));
    setTimeout(() => checkAutoUpdate(), 3000);
  } catch (err) {
    log('❌ 初始化异常，进入降级模式:', err.message);
    stableSourcesList = ['netease', 'kuwo'];
    buildPlatformsFromStableSources();
    musicSourceEnabled = true;
    backupApiAvailable = false;
    serverCheckCompleted = true;
    const sources = buildMusicSources(availablePlatforms);
    send(EVENT_NAMES.inited, { status: true, openDevTools: false, sources, initStatus: 'degraded' });
    log('降级模式完成，全部平台仍显示，但仅主API支持的可用');
    setTimeout(() => checkAutoUpdate(), 3000);
  }
})();

// ============================ 自动更新 ============================
async function checkAutoUpdate() {
  if (!musicSourceEnabled) return;
  try {
    const resp = await httpFetch(UPDATE_CONFIG.versionApiUrl, {
      timeout: 10000,
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'LX-Music-Mobile' }
    });
    if (resp.statusCode !== 200) return;
    let data = resp.body;
    if (typeof data === 'string') {
      try { data = JSON.parse(data.trim().replace(/^\uFEFF/, '')); } catch (e) { return; }
    }
    if (!data || typeof data !== 'object') return;
    const remoteVer = data.version || data.VERSION || data.ver;
    if (!remoteVer) return;
    const changelog = data.changelog || data.changelog || '暂无更新日志';
    const minReq = data.min_required || data.minRequired || 'v1.0.0';
    const updateUrl = data.update_url || data.updateUrl || UPDATE_CONFIG.latestScriptUrl;
    const needUpdate = compareVersions(remoteVer, UPDATE_CONFIG.currentVersion);
    if (needUpdate) {
      log('发现新版本:', remoteVer, '当前版本:', UPDATE_CONFIG.currentVersion);
      const force = compareVersions(remoteVer, minReq) && compareVersions(minReq, UPDATE_CONFIG.currentVersion);
      const msg = `【星海音乐源更新通知】\n当前版本：${UPDATE_CONFIG.currentVersion}\n最新版本：${remoteVer}\n\n更新内容：\n${changelog}${force ? '\n\n⚠️ 此版本需要强制更新，请立即更新以正常使用' : ''}`;
      send(EVENT_NAMES.updateAlert, {
        log: msg, updateUrl,
        confirmText: '立即更新',
        cancelText: force ? '退出应用' : '暂不更新'
      });
    }
  } catch (err) { log('更新检查失败:', err.message); }
}