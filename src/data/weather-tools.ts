export type WeatherTool = {
  id: string
  title: string
  category: string
  date: string
  image: string
  description: string
  detail: string
  links: Array<{ label: string; href: string; external?: boolean }>
}

// Thumbnail artwork and dates are from the user-supplied reference screenshot,
// not current forecasts or newly published articles.
export const weatherTools: WeatherTool[] = [
  {
    id: 'gis', title: 'GIS系集預報', category: '數值預報', date: '9月27日', image: '/images/weather-tools/gis.webp',
    description: '可以查看AIFS、WNC、GENC單一成員、或單一系統的路徑',
    detail: '比較熱帶氣旋的個別系集成員與系統路徑。本網站目前提供 WNC2 與 WM-6 的即時系集圖；AIFS、GENC 的 GIS 圖層尚未接入。下方入口可開啟現有的系集預報，或前往 ECMWF 圖表查看其他模式。',
    links: [{ label: '開啟本站系集預報', href: '#models-title' }, { label: 'ECMWF 圖表', href: 'https://charts.ecmwf.int/', external: true }],
  },
  {
    id: 'basin', title: '洋區系集預報', category: '數值預報', date: '9月13日', image: '/images/weather-tools/basin.webp',
    description: '包含WNC、GENC、AIFS的系集預報，涵蓋西太平洋、北大西洋、北印度洋等洋區。',
    detail: '依洋區查看熱帶氣旋系集路徑。本站的 WM-6 面板已有 Basin 選單，可切換西太平洋、北大西洋、東太平洋、北印度洋及南半球洋區。參考圖中的 GENC、AIFS 洋區產品尚未接入本站。',
    links: [{ label: '選擇洋區與氣旋', href: '#models-title' }],
  },
  {
    id: 'strike', title: '颱風攻擊機率', category: '數值預報', date: '9月12日', image: '/images/weather-tools/strike.webp',
    description: '包含ECMWF、WNC、EAGLE等數值預報模式、AI模式的颱風攻擊機率預報',
    detail: '攻擊機率需要明確的距離、時間範圍與成員分母，不能將路徑密集區直接當作機率。本卡片目前是參考產品介紹，本站尚未接入 ECMWF、WNC、EAGLE 攻擊機率資料；可前往 ECMWF 圖表查閱可用的熱帶氣旋產品。',
    links: [{ label: '前往 ECMWF 圖表', href: 'https://charts.ecmwf.int/', external: true }],
  },
  {
    id: 'aifs', title: 'AIFS 風雨預報', category: '數值預報', date: '9月14日', image: '/images/weather-tools/aifs.webp',
    description: '參考NHK風格的風雨預報圖，資料來源為AIFS。',
    detail: '以風場與降雨圖了解系統周邊的天氣。此縮圖來自參考截圖，並非即時風雨預報；本站尚未接入 AIFS 風雨格點資料。請由 ECMWF 圖表選擇 AIFS 及所需的起報時間、預報時效與變數。',
    links: [{ label: '查看 ECMWF / AIFS 圖表', href: 'https://charts.ecmwf.int/', external: true }],
  },
  {
    id: 'community', title: '華南氣象愛好者', category: '科普推薦', date: '11月12日', image: '/images/weather-tools/community.webp',
    description: '氣象社群與科普推薦，關注華南天氣動態、深度分析與預報討論。',
    detail: '參考截圖中的氣象社群推薦。該帳號不是本網站的官方帳號，也沒有接入本站；由於未提供原始帳號連結，下方會開啟微博名稱搜尋，請自行核對帳號身分。',
    links: [{ label: '在微博搜尋「華南氣象愛好者」', href: 'https://s.weibo.com/weibo?q=%E8%8F%AF%E5%8D%97%E6%B0%A3%E8%B1%A1%E6%84%9B%E5%A5%BD%E8%80%85', external: true }],
  },
  {
    id: 'guangdong', title: '廣東省天氣實況', category: '天氣實況', date: '12月4日', image: '/images/weather-tools/guangdong.webp',
    description: '廣東省、廣佛地區、深圳市的天氣實況（氣溫、雨量長條圖）',
    detail: '查看廣東及周邊的氣溫、降雨與觀測資訊。縮圖是參考畫面，本站尚未接入即時觀測或三維長條圖；下方連至廣東省氣象局的官方網站，請以官方發布的最新實況與警報為準。',
    links: [{ label: '廣東省氣象局', href: 'https://gd.cma.gov.cn/', external: true }],
  },
]
