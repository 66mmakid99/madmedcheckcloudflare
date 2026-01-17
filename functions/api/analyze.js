/**
 * Cloudflare Pages Function - 페이지 스크린샷 + Vision 분석 + 로그인 체크
 * 
 * 1. 외부 스크린샷 서비스로 페이지 캡처
 * 2. 전후사진/후기 관련 링크 발견 시 실제 접근하여 로그인 필요 여부 체크
 * 3. Claude Vision API로 시각적 맥락 분석
 * 4. 메뉴명 vs 실제 콘텐츠 구분, 로그인 필요 여부 판단
 */

export async function onRequest(context) {
  const { request, env } = context;
  
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  if (request.method !== 'POST') {
    return new Response(
      JSON.stringify({ error: 'POST 요청만 지원합니다.' }),
      { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  try {
    const { url, suspectedViolations, text } = await request.json();

    if (!url || !suspectedViolations) {
      return new Response(
        JSON.stringify({ error: 'URL과 의심 항목이 필요합니다.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const apiKey = env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return new Response(
        JSON.stringify({ error: 'API 키가 설정되지 않았습니다.', fallback: true }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // 1. 로그인 필요 여부 사전 체크 (전후사진/후기 관련 항목)
    const loginCheckResults = await checkLoginRequirements(url, text, suspectedViolations);

    // 2. 스크린샷 URL 생성 (WordPress mshots - 한국 사이트 지원 좋음)
    const screenshotUrl = `https://s.wordpress.com/mshots/v1/${encodeURIComponent(url)}?w=1280`;
    
    // 3. 스크린샷 가져와서 Claude Vision에 전달
    let screenshotBase64 = null;
    let screenshotAvailable = false;
    
    // 여러 서비스 시도
    const screenshotServices = [
      `https://s.wordpress.com/mshots/v1/${encodeURIComponent(url)}?w=1280`,
      `https://image.thum.io/get/width/1280/${encodeURIComponent(url)}`,
    ];
    
    for (const serviceUrl of screenshotServices) {
      if (screenshotAvailable) break;
      
      try {
        const screenshotResponse = await fetch(serviceUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
        });
        
        if (screenshotResponse.ok) {
          const contentType = screenshotResponse.headers.get('content-type');
          // 이미지인지 확인 (일부 서비스는 에러 시 HTML 반환)
          if (contentType && contentType.includes('image')) {
            const arrayBuffer = await screenshotResponse.arrayBuffer();
            const uint8Array = new Uint8Array(arrayBuffer);
            
            // Cloudflare Workers 호환 base64 인코딩
            let binary = '';
            const chunkSize = 8192;
            for (let i = 0; i < uint8Array.length; i += chunkSize) {
              const chunk = uint8Array.slice(i, i + chunkSize);
              binary += String.fromCharCode.apply(null, chunk);
            }
            screenshotBase64 = btoa(binary);
            screenshotAvailable = true;
            console.log('Screenshot captured from:', serviceUrl);
          }
        }
      } catch (e) {
        console.error('Screenshot error from', serviceUrl, ':', e.message);
      }
    }

    // 4. Claude Vision API 호출
    const messages = [];
    const content = [];

    if (screenshotBase64) {
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/jpeg',
          data: screenshotBase64
        }
      });
    }

    content.push({
      type: 'text',
      text: buildVisionPrompt(url, suspectedViolations, text, !!screenshotBase64, loginCheckResults)
    });

    messages.push({ role: 'user', content });

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 3000,
        messages
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Claude API error:', errorText);
      return new Response(
        JSON.stringify({ error: 'AI 분석 중 오류', fallback: true }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const data = await response.json();
    const analysisResult = parseAnalysisResult(data.content[0].text);

    return new Response(
      JSON.stringify({
        success: true,
        analysis: analysisResult,
        screenshotUrl: screenshotUrl,
        hasScreenshot: screenshotAvailable,
        loginCheckResults,
        analyzedAt: new Date().toISOString()
      }),
      { 
        status: 200, 
        headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' } 
      }
    );

  } catch (error) {
    console.error('Vision analysis error:', error);
    return new Response(
      JSON.stringify({ error: error.message, fallback: true }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
}

/**
 * 전후사진/후기 관련 링크 접근하여 로그인 필요 여부 체크
 */
async function checkLoginRequirements(baseUrl, text, suspectedViolations) {
  const results = {};
  
  // 전후사진/후기 관련 카테고리만 체크
  const targetCategories = ['치료경험담'];
  const relevantViolations = suspectedViolations.filter(v => 
    targetCategories.includes(v.category)
  );
  
  if (relevantViolations.length === 0) {
    return results;
  }

  try {
    // 기본 URL의 HTML 가져오기
    const response = await fetch(baseUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    const html = await response.text();
    
    // 로그인 관련 키워드 체크
    const loginKeywords = [
      '로그인', 'login', '회원전용', '회원 전용', '회원만', 
      '로그인 후', '로그인후', '비회원', '열람불가', '권한이 없',
      '회원가입', 'signin', 'sign-in', 'member only'
    ];
    
    // 전후사진/후기 관련 링크 패턴
    const linkPatterns = [
      /href=["']([^"']*(?:전후|before|after|후기|review|gallery)[^"']*)["']/gi,
      /href=["']([^"']*(?:ba|b-a|beforeafter)[^"']*)["']/gi
    ];
    
    const foundLinks = [];
    for (const pattern of linkPatterns) {
      let match;
      while ((match = pattern.exec(html)) !== null) {
        foundLinks.push(match[1]);
      }
    }
    
    // 발견된 링크 체크
    for (const link of foundLinks.slice(0, 3)) { // 최대 3개만 체크
      try {
        const fullUrl = link.startsWith('http') ? link : new URL(link, baseUrl).href;
        const linkResponse = await fetch(fullUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0' },
          redirect: 'follow'
        });
        const linkHtml = await linkResponse.text();
        
        // 로그인 폼이나 로그인 요구 메시지 체크
        const requiresLogin = loginKeywords.some(keyword => 
          linkHtml.toLowerCase().includes(keyword.toLowerCase())
        ) || linkHtml.includes('type="password"') || linkHtml.includes("type='password'");
        
        results[link] = {
          checked: true,
          requiresLogin,
          url: fullUrl
        };
      } catch (e) {
        results[link] = { checked: false, error: e.message };
      }
    }
    
    // 메인 페이지에서 로그인 관련 표시 체크
    results._mainPage = {
      hasLoginIndicators: loginKeywords.some(keyword => 
        html.toLowerCase().includes(keyword.toLowerCase())
      ),
      hasPasswordField: html.includes('type="password"') || html.includes("type='password'")
    };
    
  } catch (e) {
    results._error = e.message;
  }
  
  return results;
}

function buildVisionPrompt(url, suspectedViolations, text, hasImage, loginCheckResults) {
  // 키워드 발견 여부에 따라 다른 프롬프트
  const hasKeywords = suspectedViolations && suspectedViolations.length > 0;
  
  let violationsList = '';
  if (hasKeywords) {
    violationsList = suspectedViolations.map((v, i) => {
      return `${i + 1}. 카테고리: ${v.category}
   발견된 표현: ${v.matches.join(', ')}
   발견된 문맥: "${v.context}"
   위반 기준: ${v.criteria}`;
    }).join('\n\n');
  }

  // 로그인 체크 결과 정리
  let loginCheckInfo = '';
  if (loginCheckResults && Object.keys(loginCheckResults).length > 0) {
    const checkedLinks = Object.entries(loginCheckResults)
      .filter(([key]) => !key.startsWith('_'))
      .map(([link, result]) => {
        if (result.requiresLogin) {
          return `- ${link}: ✅ 로그인 필요 확인됨`;
        } else if (result.checked) {
          return `- ${link}: ❌ 공개 접근 가능`;
        }
        return null;
      })
      .filter(Boolean);
    
    if (checkedLinks.length > 0) {
      loginCheckInfo = `
## 🔐 로그인 필요 여부 사전 체크 결과
실제 링크에 접근하여 확인한 결과입니다:
${checkedLinks.join('\n')}

이 정보를 반드시 판단에 반영하세요.`;
    }
  }

  const imageInstruction = hasImage 
    ? `## 스크린샷 분석
위 이미지는 해당 웹페이지의 스크린샷입니다. 
${hasKeywords ? `이미지를 보고 각 의심 표현이 어디에 위치하는지 확인하세요:` : `텍스트 추출이 되지 않은 페이지입니다. 스크린샷을 직접 분석하여 의료광고법 위반 가능성이 있는 표현을 찾아주세요:`}
- 상단/사이드 네비게이션 메뉴에 있는 텍스트인가?
- 본문 콘텐츠 영역에 있는 광고 문구인가?
- 시술 결과 사진과 함께 있는가?
- 팝업/배너 광고인가?
- "로그인", "회원전용", "로그인 후 확인" 등의 표시가 있는가?
- "최고", "1위", "100%", "완치" 등 과장 표현이 있는가?
- 전후 사진, 시술 후기가 공개되어 있는가?

시각적 맥락을 기반으로 판단하세요.`
    : `## 텍스트 분석
스크린샷을 가져오지 못했습니다. 텍스트만으로 분석하되, 
메뉴명일 가능성이 있는 경우 "확인 필요"로 표시하세요.`;

  // 키워드가 없을 때는 전체 페이지 분석 모드
  const analysisMode = hasKeywords 
    ? `## 1차 키워드 검사에서 발견된 의심 항목
${violationsList}`
    : `## 1차 키워드 검사 결과
텍스트 추출이 되지 않았거나 키워드가 발견되지 않았습니다.
**스크린샷을 직접 분석하여** 의료광고법 위반 가능성이 있는 표현을 찾아주세요.

주요 체크 항목:
1. 과장 표현: "최고", "No.1", "1위", "최초", "유일" 등
2. 효과 보장: "100%", "완치", "보장", "확실" 등  
3. 치료 경험담: "전후 사진", "시술 후기", "B/A" 등
4. 환자 유인: "할인", "이벤트", "무료", "캐시백" 등
5. 비교 광고: "타 병원", "vs" 등`;

  return `당신은 의료광고 법규 전문가입니다. 보건복지부 '건강한 의료광고 가이드라인 2판(2024.12)'을 기준으로 분석합니다.

## 분석 대상 URL
${url}

${imageInstruction}
${loginCheckInfo}

## 추출된 텍스트 (참고용)
"""
${text ? text.substring(0, 2000) : '(텍스트 추출 불가 - JavaScript 렌더링 페이지일 수 있음)'}
"""

${analysisMode}

## 판단 기준

### ⭐ 핵심: 로그인/회원전용 콘텐츠 체크 (매우 중요)
"전후사진", "시술후기", "치료후기", "B/A" 등의 표현이 발견되더라도:
- 해당 메뉴/링크 클릭 시 **로그인이 필요**하거나
- **"회원전용"**, **"로그인 후 확인"**, **"비회원 열람불가"** 등의 표시가 있거나
- 실제 전후 사진/후기 콘텐츠가 **로그인 없이는 보이지 않는** 경우
→ **법적으로 문제없음** (의료법상 '불특정 다수에게 공개'가 아니므로)

이 경우 isViolation: false로 판정하고, reason에 "로그인 필요 콘텐츠로 확인됨"을 명시하세요.

### 기타 판단 기준
1. **메뉴명/버튼명**: 네비게이션, 사이드바, 푸터 등에 있는 메뉴 텍스트 자체는 위반 아님
   - 단, 해당 메뉴 클릭 시 로그인 없이 전후사진이 바로 보인다면 → 위반
   - 로그인 필요하다면 → 문제없음
   
2. **실제 광고 콘텐츠**: 본문, 배너, 팝업에서 로그인 없이 누구나 볼 수 있는 전후사진/후기 → 위반
   
3. **시술명/패키지명**: 시술 상품명의 일부 → 위반 아님
   예: "베스트 No.1 패키지" (상품명) → 위반 아님
   예: "국내 No.1 피부과" (병원 자칭) → 위반

## 응답 형식 (JSON)
{
  "results": [
    {
      "index": 1,
      "category": "카테고리명",
      "matches": ["발견된 표현"],
      "isViolation": true/false,
      "confidence": "high"/"medium"/"low",
      "visualLocation": "메뉴바/본문/배너/팝업/확인불가",
      "requiresLogin": true/false,
      "boundingBox": {
        "x": 0-100,
        "y": 0-100,
        "width": 0-100,
        "height": 0-100
      },
      "reason": "시각적 위치와 맥락을 기반으로 판단 이유 설명 (친절한 톤). 로그인 필요 여부를 반드시 언급.",
      "suggestion": "수정이 필요한 경우 구체적인 수정 제안"
    }
  ],
  "overallAssessment": "전체 페이지에 대한 종합 의견 (로그인 필요 콘텐츠 여부 포함)",
  "summary": "분석 요약 (친절한 톤)"
}

**boundingBox 설명**: 
- 스크린샷 이미지에서 해당 텍스트가 위치한 영역을 백분율(%)로 표시
- x: 왼쪽 가장자리에서의 시작 위치 (0-100%)
- y: 상단에서의 시작 위치 (0-100%)
- width: 박스의 너비 (0-100%)
- height: 박스의 높이 (0-100%)
- 예: 화면 중앙 상단에 있다면 {"x": 30, "y": 10, "width": 40, "height": 5}
- 정확히 찾을 수 없으면 null로 설정

JSON만 출력하세요.`;
}

function parseAnalysisResult(responseText) {
  try {
    let jsonStr = responseText;
    const jsonMatch = responseText.match(/```json\s*([\s\S]*?)\s*```/);
    if (jsonMatch) jsonStr = jsonMatch[1];
    
    const startIdx = jsonStr.indexOf('{');
    const endIdx = jsonStr.lastIndexOf('}');
    if (startIdx !== -1 && endIdx !== -1) {
      jsonStr = jsonStr.substring(startIdx, endIdx + 1);
    }
    
    return JSON.parse(jsonStr);
  } catch (e) {
    console.error('JSON parsing error:', e);
    return { results: [], summary: 'AI 응답 파싱 실패', parseError: true };
  }
}
