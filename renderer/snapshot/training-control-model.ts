export interface TrainingControlPresentation {
  active: boolean;
  ariaLabel: string;
  title: string;
}

export function trainingControlPresentation(on: boolean): TrainingControlPresentation {
  return {
    active: on,
    ariaLabel: on ? "Turn Learning Mode off" : "Turn Learning Mode on",
    title: on ? "Learning Mode is on" : "Learning Mode is off",
  };
}
