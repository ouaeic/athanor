export type View = 'work' | 'library' | 'computer' | 'settings' | 'attention';
export function initialNavigation() {
  const params = new URLSearchParams(location.search);
  const view = params.get('view');
  return {
    taskId: params.get('task'),
    view: (['work', 'library', 'computer', 'settings', 'attention'].includes(view ?? '')
      ? view
      : 'work') as View
  };
}
