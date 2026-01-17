/**
 * Cloudflare Pages Function - URL 크롤링 API
 * 
 * 엔드포인트: /api/crawl?url=https://example.com
 * 
 * 사용법:
 * fetch('/api/crawl?url=' + encodeURIComponent('https://blog.naver.com/xxx'))
 */

export async function onRequest(context) {
  const { request } = context;
  const startTime = Date.now();
  
  // CORS 헤더
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  // OPTIONS 요청 처리 (CORS preflight)
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // URL 파라미터 추출
    const url = new URL(request.url);
    const targetUrl = url.searchParams.get('url');

    if (!targetUrl) {
      return new Response(
        JSON.stringify({ error: 'URL 파라미터가 필요합니다. 예: /api/crawl?url=https://example.com' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // URL 유효성 검사
    let parsedUrl;
    try {
      parsedUrl = new URL(targetUrl);
    } catch (e) {
      return new Response(
        JSON.stringify({ error: '유효하지 않은 URL입니다.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // 허용된 프로토콜 확인
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      return new Response(
        JSON.stringify({ error: 'HTTP/HTTPS URL만 지원합니다.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // 페이지 가져오기
    const response = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
      },
      redirect: 'follow',
    });

    if (!response.ok) {
      return new Response(
        JSON.stringify({ error: `페이지를 가져올 수 없습니다. (${response.status})` }),
        { status: response.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const html = await response.text();

    // HTML에서 텍스트 추출
    const text = extractTextFromHtml(html);

    // 메타 정보 추출
    const title = extractTitle(html);
    const description = extractMetaDescription(html);
    
    // 상세 분석 정보 수집
    const analysisStats = analyzePageStructure(html);
    
    const endTime = Date.now();
    const crawlDuration = ((endTime - startTime) / 1000).toFixed(2);

    return new Response(
      JSON.stringify({
        success: true,
        url: targetUrl,
        title: title,
        description: description,
        text: text,
        textLength: text.length,
        stats: {
          crawlDuration: parseFloat(crawlDuration),
          ...analysisStats
        },
        crawledAt: new Date().toISOString()
      }),
      { 
        status: 200, 
        headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' } 
      }
    );

  } catch (error) {
    console.error('Crawl error:', error);
    return new Response(
      JSON.stringify({ error: '크롤링 중 오류가 발생했습니다: ' + error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
}

/**
 * 페이지 구조 분석
 */
function analyzePageStructure(html) {
  // 링크 수 (내부/외부)
  const allLinks = html.match(/<a[^>]+href=/gi) || [];
  const internalLinks = html.match(/<a[^>]+href=["'](?!http|\/\/)[^"']*["']/gi) || [];
  const externalLinks = allLinks.length - internalLinks.length;
  
  // 이미지 수
  const images = html.match(/<img[^>]+/gi) || [];
  
  // 폼 수
  const forms = html.match(/<form[^>]*/gi) || [];
  
  // 주요 섹션 수
  const sections = (html.match(/<section[^>]*/gi) || []).length +
                   (html.match(/<article[^>]*/gi) || []).length +
                   (html.match(/<div[^>]*class="[^"]*(?:section|content|main|wrapper)[^"]*"/gi) || []).length;
  
  // 네비게이션 메뉴 수
  const navElements = (html.match(/<nav[^>]*/gi) || []).length +
                      (html.match(/<ul[^>]*class="[^"]*(?:menu|nav|gnb|lnb)[^"]*"/gi) || []).length;
  
  // 버튼 수
  const buttons = (html.match(/<button[^>]*/gi) || []).length +
                  (html.match(/<input[^>]*type=["'](?:submit|button)["']/gi) || []).length;
  
  // 스크립트/스타일 파일 수
  const scripts = (html.match(/<script[^>]+src=/gi) || []).length;
  const styles = (html.match(/<link[^>]+stylesheet/gi) || []).length;
  
  // 메타 태그 수
  const metaTags = (html.match(/<meta[^>]+/gi) || []).length;
  
  // 테이블 수 (가격표 등)
  const tables = (html.match(/<table[^>]*/gi) || []).length;
  
  // 동영상/임베드 수
  const videos = (html.match(/<video[^>]*/gi) || []).length +
                 (html.match(/<iframe[^>]*/gi) || []).length;

  return {
    totalLinks: allLinks.length,
    internalLinks: internalLinks.length,
    externalLinks: externalLinks,
    images: images.length,
    forms: forms.length,
    sections: Math.max(sections, 1),
    navElements: navElements,
    buttons: buttons,
    scripts: scripts,
    styles: styles,
    metaTags: metaTags,
    tables: tables,
    videos: videos,
    totalElements: allLinks.length + images.length + buttons + forms.length + tables + videos
  };
}

/**
 * HTML에서 텍스트 추출
 */
function extractTextFromHtml(html) {
  // script, style, noscript 태그 제거
  let text = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');

  // 주요 콘텐츠 영역 우선 추출 시도
  const contentPatterns = [
    /<article[^>]*>([\s\S]*?)<\/article>/gi,
    /<main[^>]*>([\s\S]*?)<\/main>/gi,
    /<div[^>]*class="[^"]*content[^"]*"[^>]*>([\s\S]*?)<\/div>/gi,
    /<div[^>]*class="[^"]*post[^"]*"[^>]*>([\s\S]*?)<\/div>/gi,
    /<div[^>]*class="[^"]*article[^"]*"[^>]*>([\s\S]*?)<\/div>/gi,
    // 네이버 블로그
    /<div[^>]*class="[^"]*se-main-container[^"]*"[^>]*>([\s\S]*?)<\/div>/gi,
    /<div[^>]*id="post[^"]*"[^>]*>([\s\S]*?)<\/div>/gi,
  ];

  let extractedContent = '';
  for (const pattern of contentPatterns) {
    const matches = html.match(pattern);
    if (matches && matches.length > 0) {
      extractedContent += matches.join(' ');
    }
  }

  // 콘텐츠 영역을 찾았으면 그것 사용, 아니면 전체 body 사용
  if (extractedContent.length > 100) {
    text = extractedContent;
  }

  // HTML 태그 제거
  text = text.replace(/<[^>]+>/g, ' ');

  // HTML 엔티티 디코딩
  text = text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (match, dec) => String.fromCharCode(dec))
    .replace(/&#x([0-9a-f]+);/gi, (match, hex) => String.fromCharCode(parseInt(hex, 16)));

  // 공백 정리
  text = text
    .replace(/\s+/g, ' ')
    .replace(/\n\s*\n/g, '\n')
    .trim();

  // 최대 길이 제한 (10000자)
  if (text.length > 10000) {
    text = text.substring(0, 10000) + '...';
  }

  return text;
}

/**
 * 페이지 타이틀 추출
 */
function extractTitle(html) {
  const match = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  return match ? match[1].trim() : '';
}

/**
 * 메타 설명 추출
 */
function extractMetaDescription(html) {
  const match = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)["']/i) ||
                html.match(/<meta[^>]*content=["']([^"']*)["'][^>]*name=["']description["']/i);
  return match ? match[1].trim() : '';
}
