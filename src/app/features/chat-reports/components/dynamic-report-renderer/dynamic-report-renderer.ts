import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { KpiGridComponent } from '../kpi-grid/kpi-grid';
import { ChartWidgetComponent } from '../chart-widget/chart-widget';
import { DynamicTableComponent } from '../dynamic-table/dynamic-table';
import { HtmlDocumentComponent } from '../html-document/html-document';
import {
  ChartComponentSpec,
  HtmlDocumentComponentSpec,
  KpiGridComponentSpec,
  ReportComponent,
  TableComponentSpec,
  TemplateType,
} from '../../models/report-payload.model';

/**
 * Renders the `components[]` array of a report payload.
 *
 * ## Why `@switch` and not dynamic component loading
 *
 * `ngComponentOutlet` / `createComponent` would let the set of renderable types
 * be open-ended, and that is exactly what is not wanted here. The payload comes
 * from an LLM: the renderable set must be CLOSED and known at compile time, so
 * an unrecognised `type` can only ever fall through to nothing. A switch over a
 * discriminated union also gets the compiler to prove every case is handled —
 * add a member to `ReportComponent` and the narrowing helpers below stop
 * compiling until it is rendered somewhere.
 *
 * It is also lighter: three statically-imported components tree-shake and
 * lazy-load with the route, where a dynamic registry would pin all of them.
 */
@Component({
  selector: 'app-dynamic-report-renderer',
  imports: [KpiGridComponent, ChartWidgetComponent, DynamicTableComponent, HtmlDocumentComponent],
  templateUrl: './dynamic-report-renderer.html',
  styleUrl: './dynamic-report-renderer.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DynamicReportRendererComponent {
  readonly components = input.required<ReportComponent[]>();
  /** Drives the layout rhythm — see {@link spacing}. */
  readonly templateType = input<TemplateType>('custom_report');

  /**
   * How much air sits between sections.
   *
   * `kpi_overview` leads with numbers and stays tight so the tiles read as one
   * block. `detailed_analytics` is charts and tables, which need room to be
   * read separately rather than as a wall.
   */
  protected readonly spacing = computed(() =>
    this.templateType() === 'kpi_overview' ? 'gap-3' : 'gap-4',
  );

  /*
   * Narrowing helpers. Angular templates cannot narrow a discriminated union
   * through `@switch`, so each case asserts the member it already matched.
   * Typed rather than cast to `any` — a wrong `type` string here is a compile
   * error, which is the point (NG-CORE-01).
   */
  protected asKpiGrid(component: ReportComponent): KpiGridComponentSpec {
    return component as KpiGridComponentSpec;
  }

  protected asChart(component: ReportComponent): ChartComponentSpec {
    return component as ChartComponentSpec;
  }

  protected asTable(component: ReportComponent): TableComponentSpec {
    return component as TableComponentSpec;
  }

  protected asHtmlDocument(component: ReportComponent): HtmlDocumentComponentSpec {
    return component as HtmlDocumentComponentSpec;
  }
}
