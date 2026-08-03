/**
 * Netlify Edge Function: Markdown Content Delivery
 * 
 * Serves Markdown instead of HTML when AI agents request it (via `Accept: text/markdown`),
 * reducing token usage by ~80%.
 * 
 * ---
 * TESTING & USAGE INSTRUCTIONS:
 * 
 * 1. Testing with curl:
 *    curl -H "Accept: text/markdown" https://your-site.netlify.app/
 *    curl -H "Accept: text/markdown" https://your-site.netlify.app/public/index.html
 * 
 * 2. Testing locally with Netlify CLI:
 *    netlify dev (or /opt/buildhome/node-deps/node_modules/.bin/netlify dev --port 8889)
 *    curl -H "Accept: text/markdown" http://localhost:8889/
 * 
 * 3. Adding or removing paths from Edge Function scope:
 *    Edit `netlify.toml` and add or remove [[edge_functions]] entries:
 * 
 *    [[edge_functions]]
 *      path = "/your-content-path"
 *      function = "markdown"
 * 
 *    To exclude specific paths, remove their [[edge_functions]] mapping or adjust path patterns in `netlify.toml`.
 */

import type { Context } from "@netlify/edge-functions";
import TurndownService from "https://esm.sh/turndown@7.2.0";

export default async (request: Request, context: Context) => {
  const acceptHeader = request.headers.get("accept") || "";
  
  if (!acceptHeader.includes("text/markdown")) {
    return context.next();
  }

  try {
    const response = await context.next();
    const contentType = response.headers.get("content-type") || "";

    if (!contentType.includes("text/html")) {
      return response;
    }

    const html = await response.text();

    // Strip non-content elements (scripts, styles, nav, footer, header, sidebars)
    const cleanHtml = html
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
      .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
      .replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, "")
      .replace(/<header\b[^<]*(?:(?!<\/header>)<[^<]*)*<\/header>/gi, "")
      .replace(/<footer\b[^<]*(?:(?!<\/footer>)<[^<]*)*<\/footer>/gi, "")
      .replace(/<nav\b[^<]*(?:(?!<\/nav>)<[^<]*)*<\/nav>/gi, "")
      .replace(/<aside\b[^<]*(?:(?!<\/aside>)<[^<]*)*<\/aside>/gi, "");

    const turndownService = new TurndownService({
      headingStyle: "atx",
      codeBlockStyle: "fenced",
    });

    const markdown = turndownService.turndown(cleanHtml);
    const estimatedTokens = Math.ceil(markdown.length / 4);

    return new Response(markdown, {
      status: 200,
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "X-Markdown-Tokens": estimatedTokens.toString(),
        "Content-Signal": "ai-train=yes, search=yes, ai-input=yes",
      },
    });
  } catch (error) {
    console.error("Markdown conversion error:", error);
    return context.next();
  }
};
