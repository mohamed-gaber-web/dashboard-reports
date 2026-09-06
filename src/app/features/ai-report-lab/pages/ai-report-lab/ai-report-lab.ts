import { ChangeDetectionStrategy, Component, HostListener, inject, signal } from '@angular/core';
import { environment } from '../../../../../environments/environment';
import { IconComponent } from '../../../../shared/ui/icon/icon';
import { ProviderSwitchComponent } from '../../../../shared/ui/provider-switch/provider-switch';
import { SkeletonComponent } from '../../../../shared/ui/skeleton/skeleton';
import { ArtifactFrameComponent } from '../../components/artifact-frame/artifact-frame';
import { LabChatComponent } from '../../components/lab-chat/lab-chat';
import { LabInspectorComponent } from '../../components/lab-inspector/lab-inspector';
import { LabExportFormat, PREVIEW_WIDTHS, PreviewWidth } from '../../models/report-artifact.model';
import { AiReportLabModel } from './ai-report-lab.model';

/**
 * AI Report Lab — an isolated prototype at `/admin/ai-report-lab`.
 *
 * ## What is being tested
 *
 * Whether letting the model generate the finished report as HTML/SVG, and
 * rendering it inside a sandboxed iframe, produces a better and more flexible
 * report than the app's existing fixed Angular renderers. Nothing here is wired
 * into the production reporting stack: the route is separate, the endpoint is
 * separate, the components are separate, and the only things shared are the D365
 * read pipeline and the shared UI primitives — neither of which is modified.
 *
 * ## Layout
 *
 * A control bar, then a workspace that fills the remaining height: the report on
 * top (fills, scrolls inside its own frame) and the conversation docked
 * underneath at a fixed height. The same arrangement as the Report Builder, for
 * the same reason — the document is the widest thing on the page, and a chat
 * column would take ~360px from it on every screen while sitting in acres of its
 * own.
 *
 * ## What this component owns
 *
 * Chrome and menus. It binds to its Model and to nothing else; the Model holds
 * every piece of state and every decision. There is no logic here that could
 * produce a figure, a filter or a document.
 */
@Component({
  selector: 'app-ai-report-lab',
  imports: [
    IconComponent,
    ProviderSwitchComponent,
    SkeletonComponent,
    ArtifactFrameComponent,
    LabChatComponent,
    LabInspectorComponent,
  ],
  providers: [AiReportLabModel],
  templateUrl: './ai-report-lab.html',
  styleUrl: './ai-report-lab.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AiReportLabComponent {
  protected readonly model = inject(AiReportLabModel);

  /**
   * Whether to mount the inspector.
   *
   * A build-time constant, not a signal. The panel renders nothing in production,
   * so no prompt and no internal schema reaches a user's screen — and removing
   * the debugging surface entirely is deleting one component and one `@if`.
   */
  protected readonly showDebug = !environment.production;

  protected readonly widths = PREVIEW_WIDTHS;

  protected readonly exportOpen = signal(false);
  protected readonly fullscreen = signal(false);
  protected readonly chatCollapsed = signal(false);

  protected readonly icons = {
    lab: 'M9 3h6M10 3v6.5L4.8 18a2 2 0 0 0 1.7 3h11a2 2 0 0 0 1.7-3L14 9.5V3M7.5 14h9',
    database: 'M12 3c4.4 0 8 1.3 8 3v12c0 1.7-3.6 3-8 3s-8-1.3-8-3V6c0-1.7 3.6-3 8-3z M4 6c0 1.7 3.6 3 8 3s8-1.3 8-3 M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
    search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.35-4.35',
    close: 'M18 6 6 18M6 6l12 12',
    check: 'M20 6 9 17l-5-5',
    chevronDown: 'm6 9 6 6 6-6',
    download: 'M12 3v12m0 0 4-4m-4 4-4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2',
    pdf: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6',
    html: 'm8 9-3 3 3 3M16 9l3 3-3 3',
    expand: 'M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7',
    collapse: 'M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7',
    retry: 'M21 12a9 9 0 1 1-3-6.7M21 3v6h-6',
    wand: 'M15 4V2m0 20v-2M4.9 4.9 3.5 3.5m17 17-1.4-1.4M4 15H2m20 0h-2M6 21 21 6l-3-3L3 18z',
    shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
  };

  /**
   * Canned refinements, offered beneath the report.
   *
   * They are sentences, not switches, and they go through the same `send` path as
   * anything typed — a button taking a private route would be a second way to
   * change the report and could drift from what typing it does. The set is chosen
   * to probe the two halves of the refinement rule: the first three are local
   * edits that must leave the rest alone, the last invites a real redesign.
   */
  protected readonly refinements = [
    { label: 'Remove the table', prompt: 'Remove the table from the report. Leave everything else exactly as it is.' },
    { label: 'Quieter design', prompt: 'Make the design cleaner and less crowded — more whitespace, fewer colours, no decoration that is not carrying meaning.' },
    { label: 'Add the comparison', prompt: 'Add a comparison against the previous period, and say what changed and by how much.' },
    { label: 'More executive', prompt: 'Make it more executive: a headline finding, four figures that matter, three insights, nothing else.' },
  ];

  protected toggleExport(event: MouseEvent): void {
    event.stopPropagation();
    this.exportOpen.update((open) => !open);
  }

  /** A menu that does not close when you click elsewhere is a menu you fight. */
  @HostListener('document:click')
  protected closeMenus(): void {
    this.exportOpen.set(false);
  }

  @HostListener('document:keydown.escape')
  protected onEscape(): void {
    this.exportOpen.set(false);
    // Escape leaving fullscreen is the convention everywhere else it exists.
    this.fullscreen.set(false);
  }

  protected runExport(format: LabExportFormat): void {
    this.exportOpen.set(false);
    void this.model.runExport(format);
  }

  protected toggleFullscreen(): void {
    this.fullscreen.update((open) => !open);
  }

  protected setWidth(width: PreviewWidth): void {
    this.model.setPreviewWidth(width);
  }

  protected onSourceChange(event: Event): void {
    this.model.selectSource((event.target as HTMLSelectElement).value);
  }

  protected onSearch(event: Event): void {
    this.model.setSearch((event.target as HTMLInputElement).value);
  }

  protected onFrom(event: Event): void {
    this.model.setFilter({ from: (event.target as HTMLInputElement).value || undefined });
  }

  protected onTo(event: Event): void {
    this.model.setFilter({ to: (event.target as HTMLInputElement).value || undefined });
  }
}
