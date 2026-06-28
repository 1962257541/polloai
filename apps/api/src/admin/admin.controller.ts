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
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  MinLength,
} from "class-validator";
import { AdminService } from "./admin.service";
import { SystemConfigService } from "./system-config.service";
import { JwtAuthGuard } from "../common/jwt-auth.guard";
import { RolesGuard } from "../common/roles.guard";
import { Roles } from "../common/roles.decorator";
import { CurrentUser, JwtUser } from "../common/current-user.decorator";
import { apiProviderValues } from "@packages/shared";

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

  // 中转站供应商：yunwu（默认）| apimart（apib.ai）| doubao（自部署 doubao-video-2api 反代）
  @IsOptional()
  @IsIn(apiProviderValues)
  apiProvider?: string;
}

class UpdateModelConfigBody {
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  imageModels!: string[];

  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  videoModels!: string[];
}

class UpdateVolcConfigBody {
  @IsOptional() @IsString() apiKey?: string;
  @IsOptional() @IsString() host?: string;
  @IsOptional() @IsString() toolVersion?: string;
  @IsOptional() @IsString() resolution?: string;
}

@Controller("admin")
@UseGuards(JwtAuthGuard, RolesGuard)
export class AdminController {
  constructor(
    private readonly adminService: AdminService,
    private readonly systemConfigService: SystemConfigService,
  ) {}

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
    return this.adminService.updateApiConfig(id, body.apiKey, body.apiUrl, body.apiProvider);
  }

  @Get("users/:id/models/catalog")
  @Roles("admin")
  getUserModelCatalog(@Param("id") id: string) {
    return this.adminService.listRemoteModels(id);
  }

  @Put("users/:id/models")
  @Roles("admin")
  updateUserModelConfig(@Param("id") id: string, @Body() body: UpdateModelConfigBody) {
    return this.adminService.updateModelConfig(id, body.imageModels, body.videoModels);
  }

  @Get("system-config/volc")
  @Roles("admin")
  getVolcConfig() {
    return this.systemConfigService.getVolcConfig();
  }

  @Put("system-config/volc")
  @Roles("admin")
  updateVolcConfig(@CurrentUser() user: JwtUser, @Body() body: UpdateVolcConfigBody) {
    return this.systemConfigService.updateVolcConfig({ ...body }, user.sub);
  }

  @Get("me")
  getMyInfo(@CurrentUser() user: JwtUser) {
    return this.adminService.getMyInfo(user.sub);
  }

  @Put("me/apikey")
  updateMyApiKey(@CurrentUser() user: JwtUser, @Body() body: UpdateApiKeyBody) {
    return this.adminService.updateApiConfig(user.sub, body.apiKey, body.apiUrl, body.apiProvider);
  }
}
