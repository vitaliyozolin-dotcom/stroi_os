import { Component, type ReactNode } from 'react';

// A failed chunk request must not remove the project menu or sync/conflict controls.
export class PageLoadBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() { return { failed: true }; }

  render() {
    if (this.state.failed) {
      return <div className="task-empty" role="alert"><strong>Не удалось загрузить раздел</strong><p>Проверьте подключение. Перед обновлением страницы убедитесь, что изменения сохранены.</p><button type="button" className="button button--primary" onClick={() => window.location.reload()}>Обновить страницу</button></div>;
    }
    return this.props.children;
  }
}
