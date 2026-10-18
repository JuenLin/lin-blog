import {
  createSeries as createSeriesService,
  getSeriesDetail as getSeriesDetailService,
  updateSeries as updateSeriesService,
  deleteSeries as deleteSeriesService,
  listSeriesByUser as listSeriesByUserService,
} from '../services/series.service.js';
import { sendOk, sendCreated } from '../utils/response.js';

// controller 只做三件事：取参数、调 service、统一响应。
// 业务判断（404 / 403 / 409）都在 service 里抛 httpError，这里不翻译、不吞掉。

export async function create(req, res, next) {
  try {
    const series = await createSeriesService(req.validated.body, req.user.userId);

    return sendCreated(res, series);
  } catch (error) {
    return next(error);
  }
}

export async function detail(req, res, next) {
  try {
    const series = await getSeriesDetailService(req.validated.params.id);

    return sendOk(res, series);
  } catch (error) {
    return next(error);
  }
}

export async function update(req, res, next) {
  try {
    const series = await updateSeriesService(
      req.validated.params.id,
      req.validated.body,
      req.user.userId,
    );

    return sendOk(res, series);
  } catch (error) {
    return next(error);
  }
}

export async function remove(req, res, next) {
  try {
    const data = await deleteSeriesService(req.validated.params.id, req.user.userId);

    return sendOk(res, data);
  } catch (error) {
    return next(error);
  }
}

export async function listByUser(req, res, next) {
  try {
    const data = await listSeriesByUserService(req.validated.params.id, req.query);

    return sendOk(res, data);
  } catch (error) {
    return next(error);
  }
}
