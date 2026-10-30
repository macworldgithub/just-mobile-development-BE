import { Injectable, Logger } from '@nestjs/common';
import { BELE_SYSTEM_PROMPT } from './chat-prompt';

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  async generateResponse(messages: Array<{ role: string; content: string }>) {
    const apiKey = process.env.OPENAI_KEY;

    if (!apiKey) {
      this.logger.warn('OPENAI_KEY is not configured in backend .env.');
      return {
        reply:
          "G'day! I'm Bele, your JustMobile assistant. (OpenAI API key is missing in backend .env).",
      };
    }

    try {
      const apiMessages = [
        { role: 'system', content: BELE_SYSTEM_PROMPT },
        ...messages.slice(-8),
      ];

      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: apiMessages,
          max_tokens: 350,
          temperature: 0.7,
        }),
      });

      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        this.logger.error(`OpenAI error status ${res.status}:`, errBody);
        return {
          reply:
            "I'm having a brief connection hiccup. JustMobile offers plans from $19/mth (20GB), $25/mth (50GB), and $35/mth (100GB) on the Telstra Wholesale Network!",
        };
      }

      const data = await res.json();
      const reply = data.choices?.[0]?.message?.content || 'No response generated.';
      return { reply };
    } catch (err) {
      this.logger.error('Failed to call OpenAI from backend:', err);
      return {
        reply:
          "Sorry, I couldn't reach the AI assistant service just now. Please try again in a moment.",
      };
    }
  }
}
