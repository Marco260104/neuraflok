export const PROJECT_COLORS = ['blue', 'green', 'amber', 'purple', 'rose', 'teal'] as const;

export type ProjectColor = (typeof PROJECT_COLORS)[number];

export type LocalProject = {
  id: string;
  name: string;
  path: string;
  color?: ProjectColor;
  createdAt: number;
  ungrouped?: boolean;
};
