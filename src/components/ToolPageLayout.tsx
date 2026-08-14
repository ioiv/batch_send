import type { ReactNode } from "react";
import { SiteFooter } from "./SiteFooter";
import { SiteHeader } from "./SiteHeader";

export type ToolPageStep = {
  description: string;
  label: string;
};

function getStepState(index: number, activeStep: number) {
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
  eyebrow,
  mainClassName = "",
  meta,
  steps,
  title
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
  steps: ToolPageStep[];
  title: string;
}) {
  const headingId = `${currentToolId}-page-title`;

  return (
    <div className="site-page site-tool-page">
      <SiteHeader currentToolId={currentToolId} />
      <main className={`shell tool-shell site-tool-shell ${mainClassName}`.trim()} id="main">
        <section className="site-tool-heading" aria-labelledby={headingId}>
          <nav className="site-tool-breadcrumb" aria-label="面包屑">
            <a href="/">工具箱</a>
            <span aria-hidden="true">/</span>
            <a href={categoryHref}>{categoryLabel}</a>
          </nav>

          <div className="site-tool-heading__copy">
            <span className="site-tool-kicker">{eyebrow}</span>
            <h1 id={headingId}>{title}</h1>
            <p>{description}</p>
            {meta ? <div className="site-tool-heading__meta">{meta}</div> : null}
          </div>

          <ol className="site-tool-steps" aria-label="操作步骤">
            {steps.map((step, index) => {
              const state = getStepState(index, activeStep);
              return (
                <li
                  aria-current={state === "active" ? "step" : undefined}
                  className={`site-tool-step is-${state}`}
                  key={`${step.label}-${index}`}
                >
                  <span className="site-tool-step__number" aria-hidden="true">
                    {state === "complete" ? "✓" : index + 1}
                  </span>
                  <span className="site-tool-step__copy">
                    <strong>{step.label}</strong>
                    <span>{step.description}</span>
                  </span>
                </li>
              );
            })}
          </ol>
        </section>

        {children}
      </main>
      <SiteFooter />
    </div>
  );
}
