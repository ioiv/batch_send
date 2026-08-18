import type { ReactNode } from "react";
import { SiteFooter } from "./SiteFooter";
import { SiteHeader } from "./SiteHeader";

export type ToolPageStep = {
  description: string;
  label: string;
};

export type ToolPageStepState = "active" | "complete" | "error" | "upcoming";

function getStepState(index: number, activeStep: number): ToolPageStepState {
  if (index < activeStep) return "complete";
  if (index === activeStep) return "active";
  return "upcoming";
}

export function ToolPageLayout({
  activeStep,
  categoryHref,
  categoryLabel,
  children,
  currentToolId,
  description,
  mainClassName = "",
  meta,
  stepStates,
  steps,
  title,
  trustLabel = "本地预检"
}: {
  activeStep: number;
  categoryHref: string;
  categoryLabel: string;
  children: ReactNode;
  currentToolId: string;
  description: string;
  eyebrow: string;
  mainClassName?: string;
  meta?: ReactNode;
  stepStates?: ToolPageStepState[];
  steps: ToolPageStep[];
  title: string;
  trustLabel?: ReactNode;
}) {
  const headingId = `${currentToolId}-page-title`;
  const descriptionId = `${currentToolId}-page-description`;

  return (
    <div className="site-page site-tool-page" data-tool={currentToolId}>
      <SiteHeader currentToolId={currentToolId} />
      <main className={`shell tool-shell site-tool-shell ${mainClassName}`.trim()} id="main">
        <section className="site-tool-heading" aria-describedby={descriptionId} aria-labelledby={headingId}>
          <div className="site-tool-context">
            <nav className="site-tool-breadcrumb" aria-label="面包屑">
              <a href="/">工具箱</a>
              <span aria-hidden="true">/</span>
              <a href={categoryHref}>{categoryLabel}</a>
            </nav>
            <span className="site-tool-trust"><i aria-hidden="true" />{trustLabel}</span>
          </div>

          <div className="site-tool-heading__body">
            <div className="site-tool-heading__copy">
              <div className="site-tool-title-row">
                <div className="site-tool-title-block">
                  <h1 id={headingId}>{title}</h1>
                </div>
                {meta ? <div className="site-tool-heading__meta">{meta}</div> : null}
              </div>
              <p className="sr-only" id={descriptionId}>{description}</p>
            </div>

            <div className="site-tool-flow">
              <ol className="site-tool-steps" aria-label="操作步骤">
                {steps.map((step, index) => {
                  const state = stepStates?.[index] || getStepState(index, activeStep);
                  return (
                    <li
                      aria-current={state === "active" ? "step" : undefined}
                      className={`site-tool-step is-${state}`}
                      key={`${step.label}-${index}`}
                    >
                      <span className="site-tool-step__number" aria-hidden="true">
                        {state === "complete" ? "✓" : state === "error" ? "!" : index + 1}
                      </span>
                      <span className="site-tool-step__copy">
                        <strong>{step.label}</strong>
                        <span className="sr-only">{step.description}；{state === "complete" ? "已完成" : state === "error" ? "需要处理错误" : state === "active" ? "当前步骤" : "尚未开始"}</span>
                      </span>
                    </li>
                  );
                })}
              </ol>
            </div>
          </div>
        </section>

        {children}
      </main>
      <SiteFooter />
    </div>
  );
}
