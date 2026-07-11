import { ChangeDetectionStrategy, Component, input, output, signal } from '@angular/core';
import { IconComponent } from '../../../../shared/ui/icon/icon';
import { ChatMessage } from '../../models/chat-message.model';

/** Conversational panel: message history, streaming reply, and the composer. */
@Component({
  selector: 'app-chat-panel',
  imports: [IconComponent],
  templateUrl: './chat-panel.html',
  styleUrl: './chat-panel.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ChatPanelComponent {
  readonly messages = input.required<ChatMessage[]>();
  readonly streaming = input('');
  readonly busy = input(false);
  readonly error = input<string | null>(null);
  readonly suggestions = input<string[]>([]);

  readonly send = output<string>();

  protected readonly draft = signal('');
  protected readonly icons = {
    sparkle: 'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z M5 3v4M3 5h4M19 17v4M17 19h4',
    send: 'M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z',
  };

  protected submit(): void {
    const text = this.draft().trim();
    if (!text || this.busy()) return;
    this.send.emit(text);
    this.draft.set('');
  }

  protected pick(suggestion: string): void {
    if (this.busy()) return;
    this.send.emit(suggestion);
  }

  protected onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      this.submit();
    }
  }
}
