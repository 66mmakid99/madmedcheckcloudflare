/**
 * Cloudflare Pages Function - AI 문맥 분석 API
 * 
 * 1차 키워드 매칭 결과를 받아서 Claude API로 문맥 분석
 * 오탐 필터링 + 정확한 위반 판정
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
    const { text, suspectedViolations } = await request.json();

    if (!text || !suspectedViolations || suspectedViolations.length === 0) {
      return new Response(
        JSON.stringify({ error: '분석할 텍스트와 의심 항목이 필요합니다.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Claude API 키 확인
    const apiKey = env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return new Response(
        JSON.stringify({ 
          error: 'API 키가 설정되지 않았습니다.',
          fallback: true // 프론트엔드에서 1차 결과만 사용하도록
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // 프롬프트 구성
    const prompt = buildAnalysisPrompt(text, suspectedViolations);

    // Claude API 호출
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2000,
        messages: [
          {
            role: 'user',
            content: prompt
          }
        ]
      })
    });

    if (!response.ok) {
      const errorData = await response.text();
      console.error('Claude API error:', errorData);
      return new Response(
        JSON.stringify({ error: 'AI 분석 중 오류가 발생했습니다.', fallback: true }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const data = await response.json();
    const analysisResult = parseAnalysisResult(data.content[0].text);

    return new Response(
      JSON.stringify({
        success: true,
        analysis: analysisResult,
        analyzedAt: new Date().toISOString()
      }),
      { 
        status: 200, 
        headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' } 
      }
    );

  } catch (error) {
    console.error('Analysis error:', error);
    return new Response(
      JSON.stringify({ error: '분석 중 오류가 발생했습니다: ' + error.message, fallback: true }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
}

/**
 * 분석 프롬프트 생성
 */
function buildAnalysisPrompt(text, suspectedViolations) {
  const violationsList = suspectedViolations.map((v, i) => {
    return `
${i + 1}. 카테고리: ${v.category}
   발견된 표현: ${v.matches.join(', ')}
   발견된 문맥: "${v.context}"
   위반 기준: ${v.criteria}`;
  }).join('\n');

  return `당신은 의료광고 법규 전문가입니다. 보건복지부 '건강한 의료광고 가이드라인 2판(2024.12)'을 기준으로 분석합니다.

## 분석할 광고 텍스트
"""
${text.substring(0, 3000)}
"""

## 1차 키워드 검사에서 발견된 의심 항목
${violationsList}

## 분석 요청
각 의심 항목에 대해 **문맥을 고려하여** 실제 위반인지 판단해주세요.

판단 기준:
- 메뉴명, 시술명, 패키지명의 일부로 사용된 경우 → 위반 아님 (예: "No.1 베스트시술"이 시술 이름인 경우)
- 의료기관이 1위, 최고라고 주장하는 경우 → 위반
- 단순 사실 설명인 경우 → 위반 아님
- 광고/마케팅 목적의 과장인 경우 → 위반

## 응답 형식 (반드시 JSON으로)
{
  "results": [
    {
      "index": 1,
      "category": "카테고리명",
      "matches": ["발견된 표현"],
      "isViolation": true 또는 false,
      "confidence": "high" 또는 "medium" 또는 "low",
      "reason": "판단 이유를 친절하게 설명",
      "suggestion": "수정이 필요한 경우 구체적인 수정 제안"
    }
  ],
  "summary": "전체 분석 요약 (친절한 톤으로)"
}

JSON만 출력하세요. 다른 설명은 불필요합니다.`;
}

/**
 * AI 응답 파싱
 */
function parseAnalysisResult(responseText) {
  try {
    // JSON 블록 추출
    let jsonStr = responseText;
    
    // ```json ... ``` 형태인 경우 추출
    const jsonMatch = responseText.match(/```json\s*([\s\S]*?)\s*```/);
    if (jsonMatch) {
      jsonStr = jsonMatch[1];
    }
    
    // { 로 시작하는 JSON 찾기
    const startIdx = jsonStr.indexOf('{');
    const endIdx = jsonStr.lastIndexOf('}');
    if (startIdx !== -1 && endIdx !== -1) {
      jsonStr = jsonStr.substring(startIdx, endIdx + 1);
    }
    
    return JSON.parse(jsonStr);
  } catch (e) {
    console.error('JSON parsing error:', e);
    return {
      results: [],
      summary: 'AI 응답 파싱에 실패했습니다.',
      parseError: true
    };
  }
}
