import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

export interface PromptOptions {
  defaultValue?: string;
  required?: boolean;
  hidden?: boolean;
}

async function hiddenQuestion(label: string): Promise<string> {
  if (!stdin.isTTY || !stdout.isTTY || typeof stdin.setRawMode !== 'function') {
    throw new Error('Hidden input requires an interactive terminal. Use --api-key or VENICE_API_KEY in non-interactive environments.');
  }

  stdout.write(label);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf-8');

  return new Promise<string>((resolve, reject) => {
    let value = '';
    const cleanup = () => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write('\n');
    };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === '\u0003') {
          cleanup();
          reject(new Error('Prompt cancelled.'));
          return;
        }
        if (char === '\r' || char === '\n') {
          cleanup();
          resolve(value);
          return;
        }
        if (char === '\u007f' || char === '\b') {
          value = value.slice(0, -1);
          continue;
        }
        if (char >= ' ') value += char;
      }
    };
    stdin.on('data', onData);
  });
}

/**
 * Banner for a run of setup questions where most answers are optional. Says
 * once, up front, what the bracketed hints on each line mean.
 */
export function printSkippableQuestionsNote(what = 'the workshop'): void {
  console.log(
    `\nMost of these are optional — press Enter to skip one and ${what} will decide.`,
  );
  console.log('A value in [brackets] is what Enter accepts.');
}

export async function promptText(label: string, options: PromptOptions = {}): Promise<string> {
  const suffix = options.defaultValue
    ? ` [${options.defaultValue}]`
    : options.required ? '' : ' [Enter to skip]';
  while (true) {
    let value: string;
    if (options.hidden) {
      value = await hiddenQuestion(`${label}${suffix}: `);
    } else {
      const rl = createInterface({ input: stdin, output: stdout });
      try {
        value = await rl.question(`${label}${suffix}: `);
      } finally {
        rl.close();
      }
    }
    const selected = value.trim() || options.defaultValue || '';
    if (selected || !options.required) return selected;
    console.error(`${label} is required.`);
  }
}

export async function promptChoice<T extends string>(
  label: string,
  choices: ReadonlyArray<{ label: string; value: T; description?: string }>,
  defaultIndex = 0,
): Promise<T> {
  console.log(`\n${label}`);
  choices.forEach((choice, index) => {
    const description = choice.description ? ` — ${choice.description}` : '';
    console.log(`  ${index + 1}. ${choice.label}${description}`);
  });
  while (true) {
    const answer = await promptText('Choose', { defaultValue: String(defaultIndex + 1), required: true });
    const selected = Number.parseInt(answer, 10) - 1;
    if (selected >= 0 && selected < choices.length) return choices[selected].value;
    console.error(`Enter a number from 1 to ${choices.length}.`);
  }
}
