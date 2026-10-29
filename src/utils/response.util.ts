export const successResponse = (
  res: any,
  data: any,
  statusCode = 200,
  message: string | null = null
) => {
  return res.status(statusCode).json({
    success: true,
    message,
    data,
  });
};