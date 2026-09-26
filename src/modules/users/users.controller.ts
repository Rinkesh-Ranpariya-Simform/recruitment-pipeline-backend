import type { Request, Response } from 'express';
import * as usersService from './users.service.js';

/** An empty result is `200 { users: [] }`, never a 404. */
export async function list(_req: Request, res: Response): Promise<void> {
  const users = await usersService.listInterviewers();

  res.status(200).json({ users });
}
