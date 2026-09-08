export type ApiValidationError = {
  message: string;
  errors: Record<string, string[]>;
  type: 'redirect' | null;
};

export type ApiResponse<T = any> = {
  data?: T;
  message?: string;
  status: number;
  meta?: any;
  errors?: Record<string, string[]>;
};
