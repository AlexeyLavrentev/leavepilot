"use strict";

module.exports = function(sequelize, DataTypes) {
    var LeaveType = sequelize.define("LeaveType", {
        name : {
            type      : DataTypes.STRING,
            allowNull : false,
        },
        color : {
            type         : DataTypes.STRING,
            allowNull    : false,
            defaultValue : '#ffffff',
        },
        use_allowance : {
            type         : DataTypes.BOOLEAN,
            allowNull    : false,
            defaultValue : true,
        },
        limit : {
            type         : DataTypes.INTEGER,
            allowNull    : false,
            defaultValue : 0,
        },
        sort_order : {
          type         : DataTypes.INTEGER,
          allowNull    : false,
          defaultValue : 0,
          comment      : "Is used to determine sorting order of leave types",
        },
        auto_approve : {
            type         : DataTypes.BOOLEAN,
            allowNull    : false,
            defaultValue : false,
        },
        minimum_consecutive_days : {
            type         : DataTypes.INTEGER,
            allowNull    : false,
            defaultValue : 0,
        },
        deduction_unit : {
            type         : DataTypes.STRING,
            allowNull    : false,
            defaultValue : 'working_days',
        },
    }, {
        

        
    });

    
    LeaveType.associate = function( models ) {
                LeaveType.belongsTo(models.Company, {as : 'company'});
                LeaveType.hasMany(models.Leave, {as : 'leaves', foreignKey : 'leaveTypeId'});
            };

    LeaveType.generate_leave_types = function(args){
                var company = args.company,
                    use_calendar_days = ['KZ', 'RU'].indexOf(company.country) !== -1,
                    holiday_name = use_calendar_days ? 'Отпуск' : 'Holiday',
                    sick_name = use_calendar_days ? 'Больничный' : 'Sick Leave';

                return LeaveType.bulkCreate([
                    {
                        name : holiday_name,
                        color : '#22AA66',
                        companyId : company.id,
                        deduction_unit : use_calendar_days ? 'calendar_days' : 'working_days',
                        minimum_consecutive_days : use_calendar_days ? 14 : 0,
                    },
                    {
                        name : sick_name,
                        color : '#459FF3',
                        companyId : company.id,
                        limit : 10,
                        use_allowance : 0,
                    },
                ])
            };

    LeaveType.prototype.is_calendar_days = function(){
            return this.deduction_unit === 'calendar_days';
          };

    LeaveType.prototype.get_color_class = function() {
            let value_in_db = this.color || '';

            return value_in_db.match(/^\s*\#/)
              ? 'leave_type_color_1'
              : value_in_db;
          };

    LeaveType.prototype.is_auto_approve = function(){
            return this.auto_approve === true;
          };

return LeaveType;
};
