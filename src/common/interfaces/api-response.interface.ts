export interface ApiSuccessResponse<T = unknown> {
  code: number;
  message: string;
  data: T;
  timestamp: string;
  path: string;
}

export interface ApiErrorResponse {
  code: number;
  message: string;
  errors: string[] | null;
  timestamp: string;
  path: string;
}
