import type { Context } from '@netlify/functions'

export default async (req: Request, context: Context) => {
  // Enable CORS if requested, although this is routed on the same domain
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS'
      }
    })
  }

  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 })
  }

  try {
    const { prompt, sys, isJson, image } = await req.json()

    // Get base URL and API Key injected by Netlify's AI Gateway
    const baseUrl = Netlify.env.get('GOOGLE_GEMINI_BASE_URL') || 'https://generativelanguage.googleapis.com'
    const apiKey = Netlify.env.get('GEMINI_API_KEY')

    if (!apiKey) {
      console.error('GEMINI_API_KEY is not configured on Netlify.')
      return Response.json({ error: 'GEMINI_API_KEY is not configured on Netlify.' }, { status: 500 })
    }

    // Construct the parts array for Gemini API (supports multimodal images)
    const parts: any[] = [{ text: prompt }]
    if (image && image.data && image.mimeType) {
      parts.push({
        inlineData: {
          mimeType: image.mimeType,
          data: image.data
        }
      })
    }

    const payload: any = {
      contents: [{ parts }],
      systemInstruction: { parts: [{ text: sys }] }
    }

    if (isJson) {
      payload.generationConfig = {
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'OBJECT',
          properties: {
            title: { type: 'STRING' },
            description: { type: 'STRING' }
          }
        }
      }
    }

    // Use gemini-2.5-flash which is widely supported and high speed
    const url = `${baseUrl}/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    })

    if (!res.ok) {
      const errorText = await res.text()
      console.error(`Gemini API error: ${res.status} - ${errorText}`)
      return Response.json({ error: `Gemini API error: ${res.status}` }, { status: res.status })
    }

    const data = await res.json()
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || ''

    return Response.json({ text }, {
      headers: {
        'Access-Control-Allow-Origin': '*'
      }
    })
  } catch (error: any) {
    console.error('Error in AI function:', error)
    return Response.json({ error: error.message || 'Internal Server Error' }, { status: 500 })
  }
}

export const config = {
  path: '/api/ai',
}
