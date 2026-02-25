/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import { actionParser } from '@ui-tars/action-parser';
import {
    UITarsModelVersion,
    MAX_PIXELS_V1_0,
    MAX_PIXELS_V1_5,
} from '@ui-tars/shared/types';

import { Model, type InvokeParams, type InvokeOutput } from './types';
import { useContext } from './context/useContext';
import { preprocessResizeImage, getSummary } from './utils';
import { DEFAULT_FACTORS } from './constants';

export interface OllamaModelConfig {
    baseURL: string; // e.g. "http://localhost:11434"
    model: string;   // e.g. "qwen2.5-vl:7b"
    temperature?: number;
    top_p?: number;
    max_tokens?: number;
}

export class OllamaModel extends Model {
    constructor(protected readonly modelConfig: OllamaModelConfig) {
        super();
    }

    get factors(): [number, number] {
        return DEFAULT_FACTORS;
    }

    get modelName(): string {
        return this.modelConfig.model;
    }

    reset() { }

    async invoke(params: InvokeParams): Promise<InvokeOutput> {
        const {
            conversations,
            images,
            screenContext,
            scaleFactor,
            uiTarsVersion,
        } = params;
        const { logger, signal } = useContext();

        logger?.info(`[OllamaModel] invoke: model=${this.modelConfig.model}, uiTarsVersion=${uiTarsVersion}`);

        const maxPixels = uiTarsVersion === UITarsModelVersion.V1_5 ? MAX_PIXELS_V1_5 : MAX_PIXELS_V1_0;
        const compressedImages = await Promise.all(
            images.map((image) => preprocessResizeImage(image, maxPixels)),
        );

        const startTime = Date.now();

        // Format messages for Ollama API
        const ollamaMessages = this.convertToOllamaMessages(conversations, compressedImages);

        try {
            const response = await fetch(`${this.modelConfig.baseURL}/api/chat`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    model: this.modelConfig.model,
                    messages: ollamaMessages,
                    stream: false,
                    options: {
                        temperature: this.modelConfig.temperature ?? 0,
                        top_p: this.modelConfig.top_p ?? 0.7,
                        num_predict: this.modelConfig.max_tokens ?? (uiTarsVersion === UITarsModelVersion.V1_5 ? 65535 : 1000),
                    },
                }),
                signal,
            });

            if (!response.ok) {
                throw new Error(`Ollama API error: ${response.status} ${response.statusText}`);
            }

            const result = await response.json();
            const prediction = result.message?.content ?? '';
            const costTime = Date.now() - startTime;
            const costTokens = result.prompt_eval_count + result.eval_count;

            logger?.info(`[OllamaModel] Response: ${prediction}`);
            logger?.info(`[OllamaModel cost]: ${costTime}ms`);

            const { parsed: parsedPredictions } = actionParser({
                prediction,
                factor: this.factors,
                screenContext,
                scaleFactor,
                modelVer: uiTarsVersion,
            });

            return {
                prediction,
                parsedPredictions,
                costTime,
                costTokens,
            };
        } catch (e) {
            logger?.error('[OllamaModel] error', e);
            throw e;
        }
    }

    private convertToOllamaMessages(conversations: any[], images: string[]): any[] {
        const messages: any[] = [];
        let imageIndex = 0;

        conversations.forEach((conv) => {
            const role = conv.from === 'human' ? 'user' : 'assistant';
            const message: any = { role, content: conv.value };

            if (conv.value === '<image>' && imageIndex < images.length) {
                message.images = [images[imageIndex]];
                imageIndex++;
            }

            messages.push(message);
        });

        return messages;
    }
}
