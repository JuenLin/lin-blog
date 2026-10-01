import { CODE, sendFail } from '../utils/response.js';

export function validate(schemas) {
  return (req, res, next) => {
    const sources = {
      body: req.body,
      query: req.query,
      params: req.params,
    };

    const validated = {};

    for (const key of Object.keys(schemas)) {
      const result = schemas[key].safeParse(sources[key]);

      if (!result.success) {
        const message = result.error.issues
          .map((issue) => `${issue.path.join('.') || key} ${issue.message}`)
          .join('; ');

        return sendFail(res, CODE.PARAM_ERROR, message, 400);
      }

      validated[key] = result.data;
    }

    req.validated = validated;

    return next();
  };
}

export default validate;
