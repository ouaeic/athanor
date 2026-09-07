import { useLayoutEffect, useRef } from 'react';

function fit(input: HTMLTextAreaElement) {
  input.style.height = '0px';
  input.style.height = `${input.scrollHeight}px`;
  input.style.overflowY = input.scrollHeight > input.clientHeight ? 'auto' : 'hidden';
}

export function useAutosizeTextarea(value: string) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    if (ref.current) fit(ref.current);
  }, [value]);
  useLayoutEffect(() => {
    const input = ref.current;
    if (!input) return;
    let width = input.clientWidth;
    const observer = new ResizeObserver(() => {
      if (input.clientWidth === width) return;
      width = input.clientWidth;
      fit(input);
    });
    observer.observe(input);
    return () => observer.disconnect();
  }, []);
  return ref;
}
