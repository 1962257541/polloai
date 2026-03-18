import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  UseGuards,
} from "@nestjs/common";
import { IsEmail, IsOptional, IsString, MinLength } from "class-validator";
import { AdminService } from "./admin.service";
import { JwtAuthGuard } from "../common/jwt-auth.guard";
import { RolesGuard } from "../common/roles.guard";
import { Roles } from "../common/roles.decorator";
import { CurrentUser, JwtUser } from "../common/current-user.decorator";

class CreateSalespersonBody {
  @IsEmail()
  email!: string;

  @IsOptional()
  @IsString()
  name?: string;

  @IsString()
  @MinLength(8)
  password!: string;
}

class UpdateApiKeyBody {
  @IsOptional()
  @IsString()
  @MinLength(10)
  apiKey?: string;

  @IsString()
  @MinLength(1)
  apiUrl!: string;

  @IsOptional()
  @IsString()
  imageModel?: string;

  @IsOptional()
  @IsString()
  imageApiType?: string;

  @IsOptional()
  @IsString()
  videoModel?: string;
}

@Controller("admin")
@UseGuards(JwtAuthGuard, RolesGuard)
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  // 仅 admin 可访问
  @Get("salespersons")
  @Roles("admin")
  listSalespersons() {
    return this.adminService.listSalespersons();
  }

  @Post("salespersons")
  @Roles("admin")
  createSalesperson(@Body() body: CreateSalespersonBody) {
    return this.adminService.createSalesperson({
      email: body.email,
      name: body.name,
      password: body.password,
    });
  }

  @Delete("salespersons/:id")
  @Roles("admin")
  deleteSalesperson(@Param("id") id: string) {
    return this.adminService.deleteSalesperson(id);
  }

  @Put("salespersons/:id/apikey")
  @Roles("admin")
  updateSalespersonApiKey(@Param("id") id: string, @Body() body: UpdateApiKeyBody) {
    return this.adminService.updateApiConfig(id, body.apiKey, body.apiUrl, body.imageModel, body.imageApiType, body.videoModel);
  }

  // 所有登录用户可访问（管理自身）
  @Get("me")
  getMyInfo(@CurrentUser() user: JwtUser) {
    return this.adminService.getMyInfo(user.sub);
  }

  @Put("me/apikey")
  updateMyApiKey(@CurrentUser() user: JwtUser, @Body() body: UpdateApiKeyBody) {
    return this.adminService.updateApiConfig(user.sub, body.apiKey, body.apiUrl, body.imageModel, body.imageApiType, body.videoModel);
  }
}
