import { Defuddle } from "defuddle/node";

export interface ConvertResult {
  markdown: string;
  title: string;
  description: string;
  domain: string;
  wordCount: number;
}

export async function convertHtml(
  html: string,
  url: string,
): Promise<ConvertResult> {
  const result = await Defuddle(html, url, { markdown: true });
  return {
    markdown: result.content,
    title: result.title,
    description: result.description,
    domain: result.domain,
    wordCount: result.wordCount,
  };
}
