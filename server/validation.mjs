import { isWorkspace } from '../src/domain.ts';

export function validateWorkspace(workspace) {
  if (!isWorkspace(workspace)) return false;
  if (workspace.tools.length > 10000 || workspace.projects.length > 10000 || workspace.assessments.length > 10000) return false;
  // Bound nested user strings and reject unknown fields to keep stored documents predictable.
  const fields = {
    tool: ['id','name','model','category','vibration','noise','source','inspectionDue','sample'],
    project: ['id','name','site','manager'],
    assessment: ['id','worker','projectId','date','activities','notes','createdAt'],
    activity: ['id','toolId','toolName','vibration','noise','minutes','source','sample'],
  };
  const validFields = (item, allowed) => Object.keys(item).every((key) => allowed.includes(key)) && Object.values(item).every((value) => typeof value !== 'string' || value.length <= 10000);
  return Object.keys(workspace).every((key) => ['version','tools','projects','assessments'].includes(key)) &&
    workspace.tools.every((item) => validFields(item, fields.tool)) &&
    workspace.projects.every((item) => validFields(item, fields.project)) &&
    workspace.assessments.every((item) => validFields(item, fields.assessment) && item.activities.length <= 1000 && item.activities.every((row) => validFields(row, fields.activity)));
}
