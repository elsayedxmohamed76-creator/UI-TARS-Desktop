/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import {
  ActionInputs,
  PredictionParsed,
  UITarsModelVersion,
  MAX_RATIO,
  IMAGE_FACTOR,
  MIN_PIXELS,
  MAX_PIXELS_V1_5,
} from '@ui-tars/shared/types';
import isNumber from 'lodash.isnumber';

function roundByFactor(num: number, factor: number): number {
  return Math.round(num / factor) * factor;
}

function floorByFactor(num: number, factor: number): number {
  return Math.floor(num / factor) * factor;
}

function ceilByFactor(num: number, factor: number): number {
  return Math.ceil(num / factor) * factor;
}

function smartResizeForV15(
  height: number,
  width: number,
  maxRatio: number = MAX_RATIO,
  factor: number = IMAGE_FACTOR,
  minPixels: number = MIN_PIXELS,
  maxPixels: number = MAX_PIXELS_V1_5,
): [number, number] | null {
  if (Math.max(height, width) / Math.min(height, width) > maxRatio) {
    console.error(
      `absolute aspect ratio must be smaller than ${maxRatio}, got ${Math.max(height, width) / Math.min(height, width)
      }`,
    );
    return null;
  }

  let wBar = Math.max(factor, roundByFactor(width, factor));
  let hBar = Math.max(factor, roundByFactor(height, factor));

  if (hBar * wBar > maxPixels) {
    const beta = Math.sqrt((height * width) / maxPixels);
    hBar = floorByFactor(height / beta, factor);
    wBar = floorByFactor(width / beta, factor);
  } else if (hBar * wBar < minPixels) {
    const beta = Math.sqrt(minPixels / (height * width));
    hBar = ceilByFactor(height * beta, factor);
    wBar = ceilByFactor(width * beta, factor);
  }

  return [wBar, hBar];
}

export function actionParser(params: {
  prediction: string;
  /** [widthFactor, heightFactor] */
  factor: number | [number, number];
  screenContext?: {
    width: number;
    height: number;
  };
  scaleFactor?: number;
  mode?: 'bc' | 'o1';
  modelVer?: UITarsModelVersion;
}): {
  parsed: PredictionParsed[];
} {
  const { prediction, factor, mode, screenContext, scaleFactor, modelVer } =
    params;

  const parsed = parseActionVlm(
    prediction,
    Array.isArray(factor) ? factor : [factor, factor],
    mode,
    screenContext,
    scaleFactor,
    modelVer,
  );

  return {
    parsed,
  };
}

export function parseActionVlm(
  text: string,
  factors: [number, number] = [1000, 1000],
  mode: 'bc' | 'o1' = 'bc',
  screenContext?: {
    width: number;
    height: number;
  },
  scaleFactor?: number,
  modelVer: UITarsModelVersion = UITarsModelVersion.V1_0,
): PredictionParsed[] {
  let reflection: string | null = null;
  let thought: string | null = null;
  let actionStr = '';

  let smartResizeFactors: [number, number] | null = null;
  if (
    modelVer === UITarsModelVersion.V1_5 &&
    screenContext?.height &&
    screenContext?.width
  ) {
    smartResizeFactors = smartResizeForV15(
      screenContext.height,
      screenContext.width,
    );
  }

  text = text.trim();
  if (mode === 'bc') {
    // Parse thought/reflection based on different text patterns
    if (text.includes('Thought:')) {
      const thoughtMatch = text.match(
        /Thought: ([\s\S]+?)(?=\s*Action[:：]|$)/,
      );

      if (thoughtMatch) {
        thought = thoughtMatch[1].trim();
      }
    } else if (text.startsWith('Reflection:')) {
      const reflectionMatch = text.match(
        /Reflection: ([\s\S]+?)Action_Summary: ([\s\S]+?)(?=\s*Action[:：]|$)/,
      );
      if (reflectionMatch) {
        thought = reflectionMatch[2].trim();
        reflection = reflectionMatch[1].trim();
      }
    } else if (text.startsWith('Action_Summary:')) {
      const summaryMatch = text.match(
        /Action_Summary: (.+?)(?=\s*Action[:：]|$)/,
      );
      if (summaryMatch) {
        thought = summaryMatch[1].trim();
      }
    }

    if (!['Action:', 'Action：'].some((keyword) => text.includes(keyword))) {
      //   throw new Error('No Action found in text');
      actionStr = text;
    } else {
      const actionParts = text.split(/Action[:：]/);
      actionStr = actionParts[actionParts.length - 1];
    }
  } else if (mode === 'o1') {
    // Parse o1 format
    const thoughtMatch = text.match(/<Thought>\s*(.*?)\s*<\/Thought>/);
    const actionSummaryMatch = text.match(
      /\nAction_Summary:\s*(.*?)\s*Action:/,
    );
    const actionMatch = text.match(/\nAction:\s*(.*?)\s*<\/Output>/);

    const thoughtContent = thoughtMatch ? thoughtMatch[1] : null;
    const actionSummaryContent = actionSummaryMatch
      ? actionSummaryMatch[1]
      : null;
    const actionContent = actionMatch ? actionMatch[1] : null;

    thought = `${thoughtContent}\n<Action_Summary>\n${actionSummaryContent}`;
    actionStr = actionContent || '';
  }

  // Parse actions - be more flexible with newlines (handle both \n and \n\n)
  const allActions = actionStr.split(/\n+/).filter(a => a.trim() !== '');
  const actions: PredictionParsed[] = [];

  for (const rawStr of allActions) {
    // prettier-ignore
    const actionInstance = parseAction(rawStr.replace(/\\n/g, String.raw`\n`).trimStart());
    let actionType = '';
    let actionInputs: ActionInputs = {};

    if (actionInstance) {
      actionType = actionInstance.function;
      const params = actionInstance.args;
      actionInputs = {};

      for (const [paramName, param] of Object.entries(params)) {
        if (!param) continue;
        const trimmedParam = (param as string).trim();

        if (paramName.includes('start_box') || paramName.includes('end_box')) {
          const oriBox = trimmedParam;
          // Remove parentheses and split
          const numbers = oriBox
            .replace(/[()[\]]/g, '')
            .split(',')
            .filter((ori) => ori !== '');

          // Convert to float and scale
          const floatNumbers = numbers.map((num, idx) => {
            const factorIndex = idx % 2;
            if (modelVer === UITarsModelVersion.V1_5 && smartResizeFactors) {
              return Number.parseFloat(num) / smartResizeFactors[factorIndex];
            }
            return Number.parseFloat(num) / factors[factorIndex];
          });

          if (floatNumbers.length === 2) {
            floatNumbers.push(floatNumbers[0], floatNumbers[1]);
          }

          actionInputs[
            paramName.trim() as keyof Omit<
              ActionInputs,
              'start_coords' | 'end_coords'
            >
          ] = JSON.stringify(floatNumbers);

          if (screenContext?.width && screenContext?.height) {
            const boxKey = paramName.includes('start_box')
              ? 'start_coords'
              : 'end_coords';
            const [x1, y1, x2 = x1, y2 = y1] = floatNumbers;
            const [widthFactor, heightFactor] = factors;

            actionInputs[boxKey] = [x1, y1, x2, y2].every(isNumber)
              ? [
                (Math.round(
                  ((x1 + x2) / 2) * screenContext?.width * widthFactor,
                ) /
                  widthFactor) *
                (scaleFactor ?? 1),
                (Math.round(
                  ((y1 + y2) / 2) * screenContext?.height * heightFactor,
                ) /
                  heightFactor) *
                (scaleFactor ?? 1),
              ]
              : [];
          }
        } else {
          actionInputs[
            paramName.trim() as keyof Omit<
              ActionInputs,
              'start_coords' | 'end_coords'
            >
          ] = trimmedParam;
        }
      }
    }

    actions.push({
      reflection: reflection,
      thought: thought || '',
      action_type: actionType,
      action_inputs: actionInputs,
    });
  }

  return actions;
}
/**
 * Parses an action string into a structured object with heuristic fallback
 * @param {string} actionStr - The action string to parse (e.g. "click(start_box='(279,81)')")
 * @returns {Object|null} Parsed action object or null if parsing fails
 */
function parseAction(actionStr: string) {
  try {
    // 1. Basic preprocessing
    actionStr = actionStr.trim();
    // Support format: click(start_box='<|box_start|>(x1,y1)<|box_end|>')
    actionStr = actionStr.replace(/<\|box_start\|>|<\|box_end\|>/g, '');

    // Normalize point/start_point/end_point to box format
    actionStr = actionStr
      .replace(/(?<!start_|end_)point=/g, 'start_box=')
      .replace(/start_point=/g, 'start_box=')
      .replace(/end_point=/g, 'end_box=');

    // 2. Try standard function call pattern: func(arg1='val', arg2='val')
    const functionPattern = /^(\w+)\((.*)\)$/;
    const match = actionStr.match(functionPattern);

    if (match) {
      const [_, functionName, argsStr] = match;
      const kwargs = {};

      if (argsStr.trim()) {
        // Split on commas that aren't inside quotes or parentheses
        const argPairs = argsStr.match(/([^,']|'[^']*')+/g) || [];

        for (const pair of argPairs) {
          const splitIdx = pair.indexOf('=');
          if (splitIdx === -1) continue;

          const key = pair.substring(0, splitIdx).trim();
          let value = pair.substring(splitIdx + 1).trim()
            .replace(/^['"]|['"]$/g, ''); // Remove surrounding quotes

          // Support <bbox> and <point> tags
          if (value.includes('<bbox>')) {
            value = value.replace(/<bbox>|<\/bbox>/g, '').replace(/\s+/g, ',');
            value = `(${value})`;
          }
          if (value.includes('<point>')) {
            value = value.replace(/<point>|<\/point>/g, '').replace(/\s+/g, ',');
            value = `(${value})`;
          }

          //@ts-ignore
          kwargs[key] = value;
        }
      }

      return {
        function: functionName,
        args: kwargs,
      };
    }

    // 3. Heuristic Fallback: Try to find coordinates and function name in free text/JSON-like output
    // This handles local models that might output: click [200, 300] or {"action": "click", "point": [200, 300]}

    // Look for common action keywords
    const commonActions = ['click', 'type', 'drag', 'scroll', 'wait', 'hover', 'finished', 'call_user'];
    const lowerStr = actionStr.toLowerCase();
    const actionFound = commonActions.find(act => lowerStr.includes(act));

    if (actionFound) {
      // Find coordinates in various formats: (x,y), [x,y], {x,y}
      const coordMatch = actionStr.match(/[([{]\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)[\])}]/);
      const kwargs: any = {};

      if (coordMatch) {
        kwargs['start_box'] = `(${coordMatch[1]},${coordMatch[2]})`;
      }

      // Handle typing text if action is 'type'
      if (actionFound === 'type') {
        const textMatch = actionStr.match(/(?:text|value|input)\s*[:=]\s*['"]?([^'"}]+)['"]?/i) ||
          actionStr.match(/type\s+['"]?([^'"]+)['"]?/i);
        if (textMatch) {
          kwargs['content'] = textMatch[1].trim();
        }
      }

      return {
        function: actionFound,
        args: kwargs
      };
    }

    return null;
  } catch (e) {
    console.error(`Failed to parse action '${actionStr}': ${e}`);
    return null;
  }
}
